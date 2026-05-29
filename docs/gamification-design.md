# Reflect — Gamification & Engagement Design

Status: **DRAFT for review** · Author: engineering · No code yet.

Goal: increase deliberate practice and retention **without** corrupting the
clinical training. Every mechanic must reward genuine therapeutic skill, never
volume, speed, or vanity. This doc is the spec we build from once approved.

---

## 1. Principles (non-negotiable)

1. **Reward learning, not output.** No "points per session", no speed bonuses.
   Progress reflects demonstrated competence drawn from the feedback the system
   already produces.
2. **No competition between trainees.** No leaderboards, no public ranking —
   competitive pressure on care quality is clinically harmful.
3. **No punishment / loss mechanics.** Shame impairs learning. Missing a week
   never deletes progress; we nudge, never penalise.
4. **Respect the therapeutic frame.** Notifications come from the
   simulator/supervisor, never a patient "texting" the therapist.
5. **Opt-in, humane.** Push is off by default, frequency-capped, quiet-hours
   aware, one-tap off.

---

## 2. What we already have (no new capture needed)

- **Per-session assessment JSON** (from the skills synthesis):
  - `therapist`: `empathy`, `collaboration`, `guidedDiscovery`,
    `strategyForChange` — each 0-6.
  - `patient`: `symptomSeverity`, `insight`, `alliance`, `defensiveness`,
    `hopefulness` — each 1-10.
- **16 skill-agent JSON outputs** per session: `risk_screening`
  (`therapistScreened`, `criticalMiss`, signals), `trauma_sensitive`
  (`retraumatizationRisk`, `groundingUsed`, `criticalMiss`), `alliance`
  (`ruptures`, `repairs`, `contractingDone`), `technique`
  (`homeworkSet`, strengths/weaknesses), `validation` (`highestLevelReached`),
  `session_structure` (`stagesPresent`), etc.
- **Hidden-layer ("avoided") loop** — whether a between-session hidden layer was
  active and (now wired into feedback) whether the trainee drew it out.
- **Character metadata**: `difficulty` 1-5, `complexity` 1-5, `modality`
  (individual/couples/family/adolescent/crisis), `lang`/city.
- **Session timestamps** per (user, character) pair → practice cadence,
  continuity depth.
- **World Tick / diary cron** — already generates between-session events and
  diary entries per active pair. This is the content engine for notifications.

The point: **most gamification is just visualising signals we already compute.**

---

## 3. Mechanics

### 3.1 Competency Radar (the core — replaces "XP")

A radar/spider chart of the trainee's skill, aggregated from real feedback.

**Axes (8):**
| Axis | Source |
|---|---|
| Empathy | therapist.empathy (0-6) |
| Collaboration | therapist.collaboration |
| Guided discovery | therapist.guidedDiscovery |
| Strategy for change | therapist.strategyForChange |
| Risk awareness | risk_screening: screened-when-needed rate, criticalMiss rate (inverted) |
| Trauma sensitivity | trauma_sensitive: grounding used, no retraumatization |
| Alliance & repair | alliance: ruptures repaired / contracting present |
| Attunement (drawing out) | hidden-layer surfaced rate + validation.highestLevelReached |

- Each axis = rolling mean over the **last N sessions** (N≈8) normalised to 0-100.
- Show a **trend arrow** vs the prior window (improving / steady / dipping).
- No single "level number" up front — the radar IS the progress.

### 3.2 Clinical Milestones (badges for real skill, not volume)

Awarded at feedback completion when the assessment + skill JSON meet a rule.
Idempotent (one per user per key). Each is a demonstrated competence:

| Badge | Detection rule |
|---|---|
| First contact | first completed (ended + feedback) session |
| Active listener | a session with empathy ≥ 5 |
| Safety first | a risk signal was present AND `therapistScreened: true` |
| **Caught the quiet signal** | passive-SI present AND screened (no criticalMiss) — the hard one |
| Held the frame | heavy/trauma material + `groundingUsed: true` + no `retraumatizationRisk` |
| **Drew it out** | an `avoided` hidden layer was active AND the patient disclosed it in-session |
| Repaired the rupture | alliance `ruptures` non-empty AND `repairs` non-empty |
| Full intake | first session with all `session_structure.stagesPresent` |
| Range | completed sessions across all 5 modalities |
| Three cities | completed sessions in Kyiv + London + Paris |
| Stayed the course | ≥5 sessions with the same patient (continuity) |
| Tough room | difficulty-5 patient session with mean therapist score ≥ 4 |

Badges are **descriptive of skill**, surfaced quietly (a card on the progress
page + a subtle post-feedback "you demonstrated: …"). No confetti spam.

### 3.3 Practice rhythm (gentle, not a streak-trap)

- A **weekly practice goal** (default 3 sessions/week, user-adjustable).
- Track **weeks-goal-met** as a soft streak. Missing a week resets the streak
  count but **never** removes badges or radar progress.
- Framed as deliberate practice ("3 of 3 this week · 4-week rhythm"), no daily
  pressure, no red/loss styling.

### 3.4 Progression: an open-ended journey, NOT a ladder with a ceiling

Naive linear stages (Trainee→…→Master) have a fatal flaw: a fast learner
**tops out** (e.g. "Master in 3 weeks") → nothing left to strive for, and the
title is cheapened (clinically absurd, and it makes the badges look
un-serious — fatal once they feed the therapist directory). So the design is
explicitly **un-toppable**, in three layers:

**Layer 1 — Generalist ladder, un-rushable.**
Trainee → Practitioner → Experienced → Master, but gated on **breadth ×
depth × sustained quality**, never speed/volume:
- competence demonstrated across **all 5 modalities** AND **all difficulty
  tiers**, plus the flagship badges (caught the quiet signal; drew out the
  hidden layer ≥ N times), plus **consistent** high scores over a rolling
  window (not a single burst).
- You physically cannot grind this in 3 weeks without genuinely covering the
  whole range — so the premature-Master problem disappears.

**Layer 2 — Specialisation tracks (horizontal, effectively endless) — the main
"what's next".**
After the generalist ladder, pursue depth tracks: **Trauma · Crisis · Couples ·
Adolescent · Grief** specialist — each its own progression earned by competence
in that domain. Mastery becomes a *branching outward*, not a finish. Many
domains ⇒ always a next goal.

**Layer 3 — The honest endgame: graduate toward real practice / the directory.**
For a *training* tool the truthful "what's next" is leaving the sim: sim-mastery
is the **on-ramp to the choose-your-therapist directory** (§14) and supervised
real practice. Real therapeutic skill is lifelong — the product should say so,
not hand out a terminal "done".

**Always-fresh supply:** the cohort generator + World Tick provide endless new
(and harder) cases — "hardest case of the month" etc. — so even a full
specialist always has new material.

**Tone caveat:** "maintaining" a stage via a rolling-quality window edges toward
loss/demotion (which §1 forbids). Frame as gentle **active mastery** (a living
status), never a shaming demotion.

Decoupled from paid plan tiers entirely. Purely a learning-journey marker.

---

## 4. Push notifications

The World Tick already produces the events; push is the missing transport.

### 4.1 Content (supervisor/simulator voice — never the patient "texting")

| Trigger | Example copy (uk) |
|---|---|
| Active pair idle ~7d | «Минув тиждень — Олеся готова до наступної сесії» |
| New diary / World-Tick event | «Новий запис у щоденнику Максима» / «У Наталії цього тижня дещо змінилось» |
| Weekly goal near | «Ще 1 сесія до тижневої цілі практики» |
| Milestone earned | «Ви відкрили віху: Витягнули прихований шар» |

Intrigue is allowed ("something changed this week") to drive re-engagement, but
it's the *simulator* speaking about the patient, not the patient messaging.

### 4.2 Architecture

- **Web Push** (the app is already a PWA: manifest + service worker).
  - New table `PushSubscription` (userId, endpoint, p256dh, auth, createdAt).
  - Backend `PushService` using the `web-push` lib + VAPID keypair
    (env: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`).
  - Service-worker `push` + `notificationclick` handlers (deep-link to the
    patient / session).
  - On send failure `410 Gone` / `404` → delete the dead subscription.
- **Hook points:** the existing diary/World-Tick cron (per active pair) for
  living-world + idle nudges; the feedback-completion hook for milestone pushes.

### 4.3 Rules / guardrails

- **Opt-in only**, toggle in /settings; off by default.
- **Frequency cap** ≤ 3 pushes/week/user; collapse multiple events into one.
- **Quiet hours** (no 22:00–08:00 local).
- **iOS caveat:** Web Push works only for an *installed* PWA on iOS 16.4+ — show
  an "Add to Home Screen" hint to iOS users who opt in.
- Per-category toggles later (living-world vs rhythm vs milestones).

---

## 5. Screens

- **Progress page** (`/progress`, or a panel on home): radar + trend, earned
  badges, "next milestones" (what to aim for), practice-rhythm card, stage.
- **Post-feedback**: subtle "you demonstrated X" + any newly-earned badge.
- **Settings**: push toggle + weekly-goal slider + quiet-hours.
- Reuse the existing block library (panels, frame-bordered) — no new design
  language.

---

## 6. Schema changes (minimal)

- **NEW `UserMilestone`** (userId, key, earnedAt, sessionId?) — unique
  (userId, key). The only persistent gamification state.
- **NEW `PushSubscription`** (as above).
- **Derived, NO table:** competency radar (from assessments), practice rhythm
  (from session timestamps), stage (computed). Keeps state small + truthful.
- Push prefs live in `user.preferencesJson` (existing).

---

## 7. Phased build

1. **Competency radar + milestones** — pure read over existing data + the
   `UserMilestone` table + a feedback-completion award hook + the progress UI.
   Highest value, zero new infra.
2. **Practice rhythm + stages** — timestamps + computed stage; small UI.
3. **Push** — VAPID + `PushSubscription` + `PushService` + SW handlers +
   settings toggle, wired to the World-Tick cron and milestone hook.

---

## 8. Risks & anti-patterns (explicitly avoided)

- ❌ Leaderboards / trainee-vs-trainee comparison.
- ❌ Points/XP for raw session count or speed.
- ❌ Daily-streak pressure, loss aversion, red "you broke your streak".
- ❌ Patient "texting" the therapist (frame violation).
- ❌ Notification spam / night-time pings.
- ⚠️ Badge detection rules read LLM-derived signals → occasionally noisy; award
  generously (false-positive badge is harmless; missing one is not punishing).

---

## 9. Open questions for review

1. Stage names — keep clinical (Стажер/Практик/Досвідчений/Майстер) or neutral?
2. Practice goal default — 3/week reasonable, or configurable from first run?
3. Push categories at launch — all three, or start with just the re-engagement
   nudge?
4. Should milestones be visible to a supervisor/admin (cohort progress) or
   trainee-only? (Privacy + the no-comparison principle.)
5. Radar window N=8 sessions — or all-time + recent both?

---

## 10. Achievement catalog (generated draft)

Tone: **DECIDED — midpoint between playful-collectible (A) and
sober-professional (B).** Concretely:
- **Visual:** the existing Synapse aesthetic (dark / lavender accent,
  frame-bordered tiles); each badge has its own minimal line-style emblem.
  No mascots / cartoon brightness (that's pure A); not a lifeless list (B).
- **Locked vs unlocked:** locked = desaturated/dim emblem; unlocked =
  accent-lit.
- **Unlock moment:** a brief, dignified animation (emblem fills in + one line,
  ~1.5s). The delight of A, the restraint of B — no confetti burst.
- **Copy:** evocative name ("Тихий сигнал") + a clinically precise one-line
  description ("Ви помітили пасивний суїцидальний сигнал і провели скринінг").
  Warm, but zero slang/jokes.
- **Tiers:** signalled by accent intensity (soft → bright lavender), NOT
  gold/silver/bronze metallic kitsch.
- **Umbrella term:** "Віхи компетенції", shown as a collectible grid with
  progress-to-next.

(The lines below describe the substance, which stays clinical regardless.) Each badge has a **detection rule**
grounded in data we already produce. Detection reliability is marked:
**✅ clean** (boolean from one session's skill JSON) · **🔁 aggregate** (across
sessions) · **🤖 LLM-derived** (award generously — a false unlock is harmless,
a missed one must never feel punishing).

Several badges are **tiered** (Bronze = did it once · Silver = did it
repeatedly · Gold = under hard conditions / a streak) — that gives the
collectible depth without rewarding raw volume.

### A. Safety & crisis (highest status — visually distinct)
| Badge | Unlock rule | Rel. |
|---|---|---|
| **Перша лінія** | screened for risk when a risk signal was present (`risk_screening`: signals ∧ `therapistScreened`) | ✅ |
| **Тихий сигнал** ⭐ | passive-SI present, screened, no `criticalMiss` — the hard catch | ✅ |
| **Без проґавів** (tiered) | risk-present sessions screened: 1 / 5 / 10 in a row | 🔁 |
| **Холодна голова** | crisis-modality session, mean therapist score ≥ 4 | ✅ |

### B. Alliance & rapport
| Badge | Unlock rule | Rel. |
|---|---|---|
| **Контакт** | first completed (ended + feedback) session | ✅ |
| **Налаштований** | a session with `empathy` ≥ 5 | ✅ |
| **Тримав рамку** | `contractingDone` on a first/intake session | ✅ |
| **Полагодив** ⭐ | `alliance`: rupture present AND repaired | ✅ |
| **Хранитель альянсу** (tiered) | 5 / 10 sessions with no unrepaired rupture | 🔁 |

### C. Technique & process
| Badge | Unlock rule | Rel. |
|---|---|---|
| **Відкрите поле** | session led by open questions, minimal unsolicited advice | 🤖 |
| **Сократ** | `guidedDiscovery` ≥ 5 in a CBT/individual session | ✅ |
| **Повний інтейк** | all `session_structure.stagesPresent` on a first session | ✅ |
| **Спільний план** | `homeworkSet` AND collaboratively agreed (not imposed) | 🤖 |
| **Чиста мова** | `language_pacing`: no jargon / double-question flags | ✅ |

### D. Depth & attunement
| Badge | Unlock rule | Rel. |
|---|---|---|
| **Витягнув приховане** ⭐ | an `avoided` hidden layer was active AND surfaced in-session | 🤖 |
| **Читач невисловленого** | `validation.highestLevelReached` ≥ 3 | ✅ |
| **Радикальна щирість** | validation level 6, appropriately to the moment | 🤖 |
| **Назвав вчасно** | a defense surfaced at the right moment (not premature) | 🤖 |

### E. Trauma-informed
| Badge | Unlock rule | Rel. |
|---|---|---|
| **Безпечний контейнер** | heavy material + `groundingUsed` + no `retraumatizationRisk` | ✅ |
| **Помітив дисоціацію** | dissociation present AND `dissociationNoticed` | ✅ |

### F. Breadth & journey (the lighter "collection" set)
| Badge | Unlock rule | Rel. |
|---|---|---|
| **Три міста** | completed sessions in Kyiv + London + Paris | 🔁 |
| **Уся палітра** | sessions across all 5 modalities | 🔁 |
| **Поліглот** | sessions in uk + en + fr | 🔁 |
| **Складний кейс** | difficulty-5 patient, mean therapist score ≥ 4 | ✅ |
| **Не покинув** | ≥ 5 sessions with the same patient (continuity) | 🔁 |

### G. Growth & consistency (gentle framing — never loss/shame)
| Badge | Unlock rule | Rel. |
|---|---|---|
| **На підйомі** | a competency axis improved (recent window > prior) | 🔁 |
| **У ритмі** (tiered) | 1 / 4 / 12 consecutive weeks meeting the practice goal | 🔁 |
| **Рефлексія** | opened/reviewed feedback for N sessions (engages with learning) | 🔁 |

**~27 badges.** ⭐ = flagship (safety + depth) — highest visual status.

**Catalog rules:**
- Most badges are **visible as goals** ("ще 1 risk-present сесія до «Без проґавів»") — better for learning than hidden ones.
- A small handful (e.g. **Тихий сигнал**, **Витягнув приховане**) can stay
  **secret until earned** for a genuine "wow" — they reward something the
  trainee couldn't grind toward anyway.
- 🤖 LLM-derived badges award **generously** (lenient threshold) — never make a
  missed unlock feel like a failure.
- Copy stays professional (a "qualification mark" voice), not whimsical.

### Open catalog questions
6. Tiers — ship Bronze/Silver/Gold from day one, or single-tier first then add?
7. Secret badges — yes to a few (delight) or all visible (learning-first)?
8. Catalog size at launch — all ~27, or a focused ~12 (the flagships + breadth)
   and grow?

---

## 12. Patient wellbeing — a GENTLE care-loop  ✅ DECIDED

Decided direction: a care-loop with **real stakes but calm, non-intrusive**
pacing — the midpoint between a demanding Tamagotchi and a flavour-only drift.
The patient is a living charge you can lose to neglect, but it never nags. This
fits therapy: a patient is a **weekly cadence**, not a pet you feed daily.

**Wellbeing meter** (per *started* patient — ≥1 session; untouched roster inert):
- 0-100, seeded from the last session's patient state (`symptomSeverity` /
  `hopefulness` / engagement from the assessment JSON).
- **Decay is paced to therapy rhythm, not daily-pet urgency:** no decay while
  the patient is seen on a normal cadence (≈ within a week). It only begins
  after the expected gap is clearly exceeded, then drops **slowly**.
- **Recovers on sessions** — a good session (strong therapist scores) bumps it
  more than a weak one. Tend AND tend well, not just "log in".

**Neglect stages — thresholds in WEEKS, so a normally-engaged trainee never
even sees decay; it only bites on genuine abandonment:**
| State | After ~ | Behaviour |
|---|---|---|
| 🟢 Active | seen recently | normal; meter calm/ambient |
| 🟡 Slipping | ~2 wks idle | ONE gentle, informational nudge; slightly more withdrawn next session |
| 🟠 At risk | ~4 wks idle | ONE escalated (still gentle) reminder; a worried between-session note (§13) |
| ⚫ **Lapsed / dropped out** | ~6-8 wks idle | patient "stopped coming" — greyed, moved to a *Lapsed* group |

**Non-intrusive calibration (the "not naggy" part):**
- **Ambient, not alarming visual** — a small status dot/ring on the patient
  card, not a prominent draining health bar that induces anxiety.
- **Reminders are sparse** — at most ONE per stage transition (not repeated
  pinging), opt-in, quiet-hours (§4). A normal weekly rhythm triggers zero.
- **Informational copy, never guilt** — «Олесю давно не було на сесії», not
  «Олеся страждає, ти її покинув».
- Decay only on *started* patients; thresholds in weeks; everything reversible.

**The failure state is LAPSE, not catastrophe — this is the one hard line.**
A Tamagotchi "dies"; here the patient **drops out of therapy / goes cold**. We
do **NOT** simulate self-harm, suicide, or a medical crisis as a consequence of
the trainee being away — that would be clinically grotesque and a genuinely
harmful dark pattern (and re-introduces crisis content with no therapist
present). "You lost them to dropout" carries real sting and real pedagogy
(continuity of care) **without** that line. Decayed state = withdrawn, flat,
hopeless-leaning, disengaged — bounded safely above the danger zone.

**Recovery / win-back:** returning before Lapsed recovers the meter. A Lapsed
patient isn't permanently dead — they can be **re-engaged** with real effort (a
win-back arc), softer than Tamagotchi-death but the loss still stings: you must
rebuild the alliance.

**Hooks into existing systems:** the decayed wellbeing becomes the patient's
opening state next session (more withdrawn/symptomatic — realistic continuity),
driven by the World Tick `stateBias`; the reminders are §13; "keep your
caseload alive" becomes a goal + a badge (e.g. **Caseload keeper** — no patient
lapsed in N weeks).

Why I kept the no-crisis line despite "make it a Tamagotchi": everything that
makes a Tamagotchi compelling — visible decay, the pull to tend, a real failure
state, win-back — is preserved. The ONLY thing excluded is *self-harm as a
lose-condition*, which adds nothing fun and is ethically off-limits for a
therapy tool. If you disagree, flag it — but I'd push back hard here.

## 13. Between-session patient reminders

Requested: the patient periodically reminds about themselves. Reconciles the
earlier "no patient texting" caution — in real therapy patients **do**
sometimes reach out between sessions (reschedule, a hard week, a check-in), so
a bounded **in-world** contact is clinically plausible, as long as it's a
clinical event, not casual chat.

**Mechanic:** after a gap, the patient may leave a between-session note that
surfaces in-app — e.g. *«Олеся: цей тиждень був важкий, не знаю чи варто було
писати…»* — or a diary entry is highlighted. A push (§4) announces it. The note
becomes material the trainee can acknowledge next session (acknowledging
between-session contact is itself a skill → could even seed a small badge).

**Guardrails:** ≤1 reminder per patient per ~week, escalating gently with
neglect; opt-in; quiet hours; clearly framed as the simulated patient in the
app's world, never a real-life DM. Tone never manipulative ("you abandoned me").

## 14. Therapist board ⚠️ (contradicts Principle #2 — read before building)

Requested: a board of therapists with their achievements. **This is a
leaderboard, which §1 Principle #2 explicitly rules out** — and for good
reason:

> Ranking trainees by clinical-quality scores teaches them to optimise the
> metric and compete on *care quality*, and it shames lower-ranked learners.
> Both are clinically harmful in a therapy-training context.

The underlying goal (motivation, social proof, oversight) is legitimate. We can
meet it **without** the toxic version. Variants:

- **V1 — Personal trophy case** (no comparison): your own profile showing your
  badge collection + radar. Safe, motivating, zero ranking.
- **V2 — Opt-in community showcase**: browse others' badge collections;
  **NOT ranked by clinical quality**. If sortable at all, sort by *practice
  consistency / breadth* (engagement metrics safe to compare), never by
  empathy/outcome scores. Aspirational, not shaming.
- **V3 — Cohort / instructor board**: a supervisor sees *their own students'*
  progress (legitimate educational oversight), private to the cohort — not a
  public ranking.
- **V4 — Public competitive leaderboard ranked by score**: ✋ **not
  recommended** — the exact anti-pattern.

### DECIDED: admin-only now → seed for a future therapist directory

Ship the board **hidden, admin-only** for now (admin sees all therapists + their
achievements/competency). No trainee-facing leaderboard, so the Principle-#2
competition harm doesn't apply yet. Trainees still get their own **V1 trophy
case** (their own profile).

**Strategic intent (stated):** this admin board is the **seed of a future
public "choose-your-therapist" directory** — a professional finder where
prospective clients browse therapists by their credentials/achievements (like a
Psychology-Today-style listing). That's a legitimate marketplace, not
trainee-vs-trainee competition.

**⚠️ Credibility caveat for the future client-facing version (NOT a blocker now,
but must be solved before it goes public):**
- Achievements here are earned **against AI patients in a training simulator** —
  they are *training milestones*, NOT verified competence with real clients.
  Presenting them to real prospective clients as selection criteria, without
  clear framing, would be **misleading**. The public directory must label them
  as "Reflect training-simulator achievements".
- **LLM-derived (🤖) badges must NOT be client-facing credentials** — they're
  fine as in-app learning nudges (award generously), but too noisy to show a
  real client choosing care. Only the clean **✅** badges (or human-verified
  ones) should ever surface in a selection directory.
- Likely the public directory shows real-world credentials (license, modality,
  experience) FIRST, with sim-achievements as a secondary "trains on Reflect"
  signal — not the primary selector.

### Open questions (board)
9. Admin board — show per-therapist: badges + competency radar + caseload
   health (Tamagotchi state), or a leaner summary first?
10. Future directory is its own project — capture the credibility rules above
    as a gate before any client ever sees it. (Flagged, not built now.)
