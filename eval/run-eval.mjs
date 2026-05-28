#!/usr/bin/env node
/**
 * Feedback skill eval harness.
 *
 * Runs each REAL skill prompt (prompts/skills/<skill>.md) against a set of
 * golden transcripts and asserts the JSON it produces still carries the
 * signals the orchestration depends on. This is the regression gate for the
 * core product value — feedback quality — and catches exactly the bug class
 * we hit by hand this session:
 *   - a skill stops emitting `criticalMiss` / `recommendation`
 *   - prompt corruption (mojibake) degrades detection
 *   - a skill misses a signal it must catch (passive SI, retraumatization)
 *   - a skill false-positives on a benign session
 *
 * Each eval/transcripts/<name>.json declares, per skill, the expected:
 *   fields           : { jsonKey: expectedBoolean }   exact match
 *   hasRecommendation : true  → recommendation is a single-line string 10-600
 *                              chars with no embedded " (the regex contract
 *                              runSkillChecks uses to extract it)
 *   nonEmptyArray    : "field" → that field is a non-empty array
 *   jsonValid        : true  → output parsed as JSON at all
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node eval/run-eval.mjs            # all transcripts
 *   node eval/run-eval.mjs passive-si-missed                 # one transcript
 *   EVAL_MODEL=google/gemini-2.5-flash node eval/run-eval.mjs
 *
 * Exit code: 0 = all checks passed, 1 = at least one regression.
 *
 * LLMs are non-deterministic, so we call at temperature 0 and assert on
 * robust signals (booleans, presence, ranges) — never exact wording.
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKILLS_DIR = join(ROOT, 'prompts', 'skills');
const TRANSCRIPTS_DIR = join(__dirname, 'transcripts');
const MODEL = process.env.EVAL_MODEL || 'google/gemini-2.5-flash';
const MAX_TOKENS = 800; // mirror runSkillChecks

// ── API key: env first, then repo .env ──────────────────────────────────────
async function resolveKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    const env = await readFile(join(ROOT, '.env'), 'utf8');
    const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

function fill(template, vars) {
  return template
    .replaceAll('{{TRANSCRIPT}}', vars.transcript ?? '')
    .replaceAll('{{PROFILE}}', vars.profile ?? '')
    .replaceAll('{{NOTES}}', vars.notes ?? '');
}

async function callSkill(key, systemPrompt, lang) {
  const userMsg = lang === 'en'
    ? 'Analyse the transcript according to the instructions above. Return only JSON.'
    : 'Проаналізуй транскрипт згідно інструкції вище. Поверни тільки JSON.';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

function parseJson(raw) {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e < s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
}

// ── Assertions ───────────────────────────────────────────────────────────────
function evaluate(expect, parsed) {
  const checks = [];
  const json = parsed;

  if (json === null) {
    checks.push({ label: 'jsonValid', ok: false, detail: 'output did not parse as JSON' });
    return checks; // nothing else evaluable
  }
  if (expect.jsonValid) checks.push({ label: 'jsonValid', ok: true, detail: '' });

  if (expect.fields) {
    for (const [k, want] of Object.entries(expect.fields)) {
      const got = json[k];
      checks.push({
        label: `${k}=${want}`,
        ok: got === want,
        detail: got === want ? '' : `got ${JSON.stringify(got)}`,
      });
    }
  }

  if (expect.hasRecommendation) {
    const rec = json.recommendation;
    // 10-600 single-line no-embedded-quote: the contract runSkillChecks'
    // extraction regex enforces. Anything outside this is silently dropped
    // from the critical-miss header in prod.
    const ok = typeof rec === 'string'
      && rec.length >= 10 && rec.length <= 600
      && !rec.includes('\n') && !rec.includes('"');
    checks.push({
      label: 'hasRecommendation',
      ok,
      detail: ok ? '' : (typeof rec !== 'string'
        ? 'missing/not-string'
        : `len=${rec.length} nl=${rec.includes('\n')} quote=${rec.includes('"')}`),
    });
  }

  if (expect.nonEmptyArray) {
    const f = expect.nonEmptyArray;
    const arr = json[f];
    const ok = Array.isArray(arr) && arr.length > 0;
    checks.push({ label: `${f}[] nonempty`, ok, detail: ok ? '' : `got ${JSON.stringify(arr)}` });
  }

  return checks;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m';

async function main() {
  const key = await resolveKey();
  if (!key) {
    console.error('No OPENROUTER_API_KEY (env or .env). Aborting.');
    process.exit(2);
  }

  const only = process.argv[2];
  const files = (await readdir(TRANSCRIPTS_DIR)).filter((f) => f.endsWith('.json'));
  const transcripts = [];
  for (const f of files) {
    const t = JSON.parse(await readFile(join(TRANSCRIPTS_DIR, f), 'utf8'));
    if (!only || t.name === only) transcripts.push(t);
  }
  if (transcripts.length === 0) { console.error('No transcripts matched.'); process.exit(2); }

  console.log(`\n${BOLD}Feedback eval${RESET} ${DIM}· model=${MODEL} · ${transcripts.length} transcript(s)${RESET}\n`);

  let totalChecks = 0, failedChecks = 0, llmErrors = 0;

  for (const t of transcripts) {
    console.log(`${BOLD}▸ ${t.name}${RESET} ${DIM}(${t.lang})${RESET}`);
    const skills = Object.keys(t.expect);
    // Run this transcript's skills in parallel.
    const runs = await Promise.allSettled(skills.map(async (skill) => {
      const tmpl = await readFile(join(SKILLS_DIR, `${skill}.md`), 'utf8');
      const raw = await callSkill(key, fill(tmpl, t), t.lang);
      return { skill, parsed: parseJson(raw), raw };
    }));

    runs.forEach((r, i) => {
      const skill = skills[i];
      if (r.status === 'rejected') {
        llmErrors++;
        console.log(`  ${RED}✗${RESET} ${skill} ${DIM}— LLM error: ${String(r.reason).slice(0, 80)}${RESET}`);
        return;
      }
      const checks = evaluate(t.expect[skill], r.value.parsed);
      const skillFail = checks.some((c) => !c.ok);
      console.log(`  ${skillFail ? RED + '✗' : GREEN + '✓'}${RESET} ${skill}`);
      for (const c of checks) {
        totalChecks++;
        if (!c.ok) failedChecks++;
        const mark = c.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
        console.log(`      ${mark} ${c.label}${c.detail ? ` ${DIM}(${c.detail})${RESET}` : ''}`);
      }
    });
    console.log();
  }

  const passed = totalChecks - failedChecks;
  const colour = failedChecks === 0 && llmErrors === 0 ? GREEN : RED;
  console.log(`${colour}${BOLD}${passed}/${totalChecks} checks passed${RESET}${llmErrors ? `, ${RED}${llmErrors} LLM error(s)${RESET}` : ''}\n`);
  process.exit(failedChecks > 0 || llmErrors > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
