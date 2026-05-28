"""
HTTP wrapper around Google Gemini TTS (primary) + Microsoft edge-tts (fallback).

Runs as the `reflect_tts` container. Backend `tts.service.ts` posts here
with text + voice, and the container returns audio bytes — WAV (Gemini)
or MP3 (edge). MIME type is set on the response so the controller can
forward it transparently.

Why Gemini primary:
  - Native multilingual neural TTS with markedly better Ukrainian
    prosody than edge-tts Polina (which sounds robotic on uk).
  - Free tier on AI Studio is enough for our scale.

Why edge-tts fallback:
  - Gemini occasionally rejects inputs ("Model tried to generate text…")
    or hits rate limits. Edge is the safety net.
  - Existing voice mapping (uk-UA-PolinaNeural etc.) still works for
    callers that pass full edge IDs.

Voice resolution:
  - Edge-tts neural ID    ('uk-UA-PolinaNeural', 'en-GB-SoniaNeural') → edge-tts
  - Bare lang code        ('uk', 'en', 'fr')                          → Gemini (if key set) else edge
  - Gemini voice name     ('Aoede', 'Kore', 'Leda', 'Iapetus', …)     → Gemini

Env:
  GEMINI_API_KEY   — required for Gemini path; if unset, edge-only.
  TTS_PROVIDER     — 'auto' (default), 'gemini', or 'edge'.
                     'auto' tries Gemini first, falls back to edge on error.
"""

import asyncio
import base64
import io
import os
import wave
from typing import Optional, Tuple

import edge_tts
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI(title="Reflect TTS", version="2.0")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts").strip()
TTS_PROVIDER = os.environ.get("TTS_PROVIDER", "auto").strip().lower()

# Gemini voices are multilingual — same voice sings every language. We
# keep a per-(lang, gender) preset table so callers passing only a bare
# lang code (or coming from the legacy edge-tts pickVoice path with no
# attributes) get a sensible default. Backend tts.service.pickVoice may
# pass the Gemini name directly too — that bypasses this table.
GEMINI_DEFAULT_VOICES = {
    ("uk", "female"): "Aoede",     # Breezy, warm — tested ✓ on Ukrainian
    ("uk", "male"):   "Iapetus",   # Clear
    ("en", "female"): "Kore",      # Firm — tested ✓
    ("en", "male"):   "Charon",    # Informative
    ("fr", "female"): "Leda",      # Youthful — tested ✓
    ("fr", "male"):   "Achird",    # Friendly
}

# Edge fallback voices when Gemini fails for a bare lang.
EDGE_FALLBACK_VOICES = {
    "uk": "uk-UA-PolinaNeural",
    "en": "en-GB-SoniaNeural",
    "fr": "fr-FR-DeniseNeural",
}

# Recognized Gemini voice names. Anything in this set is treated as a
# Gemini voice regardless of provider mode. Full list per Google docs.
GEMINI_VOICE_NAMES = {
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
}


class TtsRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice: str = Field(default="uk")
    # rate/pitch only apply to edge — kept for backwards compatibility
    rate: str = Field(default="+0%")
    pitch: str = Field(default="+0Hz")
    # optional hints to refine the auto-picked Gemini voice
    gender: Optional[str] = Field(default=None)


def classify_voice(voice: str) -> Tuple[str, str]:
    """
    Return (provider, resolved_voice_id) for a given input voice string.

    provider is 'gemini' or 'edge'. resolved_voice_id is what we pass to
    the underlying SDK.
    """
    if voice in GEMINI_VOICE_NAMES:
        return ("gemini", voice)
    # Edge-tts IDs look like 'uk-UA-PolinaNeural' — region tag + Neural suffix.
    if voice.endswith("Neural") and "-" in voice:
        return ("edge", voice)
    # Bare lang → resolved below based on provider mode + gender
    lang = voice.lower()
    if lang in ("uk", "en", "fr"):
        return ("bare", lang)
    # Unknown — pass to edge and let it error out clearly
    return ("edge", voice)


def resolve_bare_lang(lang: str, gender: Optional[str]) -> Tuple[str, str]:
    """For bare lang inputs, choose provider + concrete voice."""
    prefer_gemini = TTS_PROVIDER in ("auto", "gemini") and bool(GEMINI_API_KEY)
    g = "male" if (gender or "").lower() == "male" else "female"

    if prefer_gemini:
        voice = GEMINI_DEFAULT_VOICES.get((lang, g), GEMINI_DEFAULT_VOICES[(lang, "female")])
        return ("gemini", voice)
    return ("edge", EDGE_FALLBACK_VOICES.get(lang, EDGE_FALLBACK_VOICES["uk"]))


def pcm_to_wav(pcm: bytes, sample_rate: int = 24000) -> bytes:
    """Wrap raw signed-16 mono PCM in a WAV container so browsers decode it."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


async def synth_gemini(text: str, voice: str) -> bytes:
    """
    Call Gemini TTS. Returns WAV bytes (24kHz mono).

    Gemini's TTS-preview model sometimes treats inputs that read like
    instructions ("Je souffre…", "помоги мені…") as commands to follow
    and refuses to generate audio. The leading clause forces TTS mode.
    """
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY unset")

    prompt = f"Read aloud naturally in a warm, conversational voice: {text}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}
            },
        },
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/"
        f"models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, json=payload, headers={"content-type": "application/json"})

    if r.status_code != 200:
        raise RuntimeError(f"gemini http {r.status_code}: {r.text[:300]}")

    body = r.json()
    try:
        b64 = body["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"gemini malformed response: {str(body)[:300]}") from e

    pcm = base64.b64decode(b64)
    return pcm_to_wav(pcm, sample_rate=24000)


async def synth_edge(text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz") -> bytes:
    """Call edge-tts. Returns MP3 bytes."""
    comm = edge_tts.Communicate(text, voice=voice, rate=rate, pitch=pitch)
    buf = bytearray()
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            buf.extend(chunk["data"])
    if not buf:
        raise RuntimeError("edge-tts returned no audio")
    return bytes(buf)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "provider": TTS_PROVIDER,
        "gemini_configured": bool(GEMINI_API_KEY),
        "gemini_model": GEMINI_MODEL,
    }


@app.get("/voices")
async def voices() -> list[dict]:
    """List edge-tts voices — kept for debugging mappings."""
    return await edge_tts.list_voices()


@app.post("/tts")
async def tts(req: TtsRequest):
    provider, resolved = classify_voice(req.voice)
    if provider == "bare":
        provider, resolved = resolve_bare_lang(resolved, req.gender)

    # Mode overrides
    if TTS_PROVIDER == "edge" and provider == "gemini":
        # Force edge — map Gemini voice back to a sensible edge default
        # by language guess. Without a lang we can't do better than uk.
        provider, resolved = ("edge", EDGE_FALLBACK_VOICES["uk"])
    elif TTS_PROVIDER == "gemini" and provider == "edge":
        # Force Gemini — pick a default female voice
        provider, resolved = ("gemini", "Aoede")

    # Primary attempt
    try:
        if provider == "gemini":
            audio = await synth_gemini(req.text, resolved)
            return Response(content=audio, media_type="audio/wav")
        audio = await synth_edge(req.text, resolved, req.rate, req.pitch)
        return Response(content=audio, media_type="audio/mpeg")
    except Exception as primary_err:
        primary_msg = f"{provider}: {primary_err!s}"

        # Auto-mode fallback to the other provider
        if TTS_PROVIDER == "auto":
            try:
                if provider == "gemini":
                    # Fall to edge with a same-lang voice if we can guess it
                    # from the Gemini voice name. Otherwise default to uk.
                    lang_guess = _guess_lang_from_gemini_voice(resolved) or "uk"
                    edge_voice = EDGE_FALLBACK_VOICES[lang_guess]
                    audio = await synth_edge(req.text, edge_voice)
                    return Response(content=audio, media_type="audio/mpeg")
                # provider == 'edge' primary failed → try Gemini with bare lang
                lang_guess = _guess_lang_from_edge_voice(resolved) or "uk"
                gemini_voice = GEMINI_DEFAULT_VOICES.get((lang_guess, "female"), "Aoede")
                audio = await synth_gemini(req.text, gemini_voice)
                return Response(content=audio, media_type="audio/wav")
            except Exception as fallback_err:
                raise HTTPException(
                    status_code=502,
                    detail=f"primary failed: {primary_msg}; fallback failed: {fallback_err!s}",
                ) from fallback_err

        raise HTTPException(status_code=502, detail=primary_msg) from primary_err


def _guess_lang_from_gemini_voice(voice: str) -> Optional[str]:
    for (lang, _gender), v in GEMINI_DEFAULT_VOICES.items():
        if v == voice:
            return lang
    return None


def _guess_lang_from_edge_voice(voice: str) -> Optional[str]:
    if voice.startswith("uk-"):
        return "uk"
    if voice.startswith("en-"):
        return "en"
    if voice.startswith("fr-"):
        return "fr"
    return None
