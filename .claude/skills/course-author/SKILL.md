---
name: course-author
description: Research-driven authoring of Reflect psychotherapy courses. Use this whenever creating OR substantially expanding a course, module, or lesson (the SkillPath → Module → Step content in backend/src/courses/courses.service.ts), or when course theory feels thin/"куца". The skill's whole point: FIRST research the topic on the web, study existing real courses, and read the public clinical literature — THEN write deep, sourced, example-rich lessons in Reflect's LessonBlock format, with quizzes, figures, glossary terms and a practice checkpoint.
---

# Course Author (Reflect)

Reflect is a Ukrainian psychotherapy **practice** simulator. Courses are
skill-paths that close the **learn → practice → feedback** loop: short deep
theory → a quiz → a real session with an AI patient graded off the supervisor's
feedback signals.

The recurring failure mode is **shallow theory** ("куца теорія") — a few thin
paragraphs that restate the obvious. This skill exists to prevent that. The
rule is simple:

> **Research first, write second. Never write a lesson from memory alone.**

## The method (do this every time, in order)

### 1. Research the topic on the web
- Use `WebSearch` / `WebFetch` to find authoritative, current sources: the
  evidence base, the originating framework, clinical guidelines
  (APA Div. 12, NICE, Cochrane, WHO mhGAP), and reputable explainers.
- Capture: what the technique *is*, *why* it works (mechanism), *when* it's
  indicated/contraindicated, the *steps* a clinician actually performs, and the
  *common errors*. Note 3–6 sources with URLs.

### 2. Study existing, real courses
- Look at how mature courses teach this (Coursera / edX / Khan-style, BetterUp,
  professional CE/CPD modules, reputable training institutes, YouTube lecture
  series). `WebFetch` syllabi and lesson outlines.
- Steal *structure*, not text: how many lessons, how long each, what order,
  where they put examples, how they check understanding, how they scaffold from
  easy → hard. Reflect lessons should feel as substantial as a real module.

### 3. Read the relevant literature
- Go past blogs to primary/secondary literature: seminal texts and papers,
  manuals, and meta-analyses. For academic search use the `consensus` MCP
  (cite papers inline) and `biorxiv`/clinical-trial tools when relevant.
- Extract concrete, teachable specifics: protocols, scripts/phrasings, scales,
  decision rules, dialogue exemplars. This is what makes a lesson *deep*.

### 4. Only now — write
Synthesise the research **in our own words** into the lesson format below. Every
non-obvious claim should be traceable to a source you found (keep a short
sources list per lesson for the clinical reviewer — see Safety).

## What "deep, not куца" means — the lesson quality bar

A lesson is a `LessonBlock[]`. Aim for **~8–14 blocks / ~5–8 min read**, covering:

1. **Hook / why it matters** (`p`) — the clinical stakes in one short paragraph.
2. **Core concept** (`h` + `p`) — define it precisely; name the framework/author.
3. **Mechanism / rationale** (`p`) — *why* it works, not just *what* it is.
4. **How to do it** (`h` + `list`) — concrete, ordered steps or phrasings.
5. **A worked mini-dialogue** (`dialogue`) — therapist/client lines that model
   the skill in real Ukrainian. At least one per lesson; two for hard skills.
6. **A figure** (`figure`) — when a concept is spatial/procedural/scaled
   (a loop, a hierarchy, a triangle, a scale). See the figure library below.
7. **Do / Don't** (`list` with `term`) and **Common mistakes** (`list`).
8. **Takeaway** (`quote`) — one memorable line.

Write in plain Ukrainian (primary) + English mirror. Be concrete and
example-led; prefer a vivid dialogue over an abstract sentence. Define jargon
on first use and add it to the glossary (below).

## Reflect's course data model (emit content that drops straight in)

All course content is seeded in **`backend/src/courses/courses.service.ts`**
(`SEED_COURSES`), upserted on boot (`prisma db push` auto-applies schema; no
migration). The matching frontend types are in `frontend/src/app/api.service.ts`.

### Hierarchy
- **SkillPath** (course): `key` (unique slug), `titleUk/En`, `descUk/En`,
  `aboutUk/En` (a `LessonBlock[]` intro — "Про курс": what you'll learn +
  concrete outcomes + how it's structured), `order`, `published`, `modules[]`.
- **SkillPathModule**: `titleUk/En`, `objectivesUk/En` (string[] learning
  objectives), `steps[]`.
- **SkillPathStep**: `kind: 'lesson' | 'quiz' | 'practice'`, `titleUk/En`,
  plus per-kind fields below. Steps unlock **sequentially across the whole
  course**; completing all steps awards a milestone.

### LessonBlock types (bodyUk/bodyEn arrays)
```ts
{ type: 'h'; text }                               // sub-heading
{ type: 'p'; text }                               // paragraph
{ type: 'list'; items: { term?; text }[] }        // bullets; term = bold lead-in
{ type: 'dialogue'; lines: { who; text }[] }      // mini-transcript example
{ type: 'quote'; text }                           // callout / takeaway
{ type: 'figure'; figure: '<key>'; caption? }     // inline SVG infographic
```

### Quiz step (`quizUk/quizEn`)
```ts
{ q; options: string[]; correct: <index>; explain? }   // 2–3 questions, graded client-side
```
Write plausible distractors and a one-line `explain` for the right answer.

### Practice step
- `characterRef`: an **existing** `Character.displayName` (e.g. Анна, Максим,
  Олеся). Verify it exists in the DB / seed before using.
- `techniqueKey`: free slug for analytics (e.g. `oars`, `exposure`).
- `passSignal` (optional): a feedback signal the session must show to pass —
  one of `riskScreened`, `hiddenLayerReached`, `ruptureRepaired`,
  `traumaGrounded`. `null` = passes when the session simply gets feedback.
- Give it a 1-paragraph `bodyUk/En` task brief.

### Figures (the diagram library)
Inline, theme-aware, bilingual SVGs in
**`frontend/src/app/course-figure.component.ts`**. Reference by key:
`alliance-triangle`, `oars`, `biopsychosocial`, `risk-ladder`, `anxiety-loop`,
`grounding`, `suds`. **Need a new diagram?** Add a `@case ('<key>')` with an
SVG (use the existing `.t-fg/.t-accent/.stroke-accent` classes + `tr()` labels),
then reference it as a `figure` block. Prefer a code-drawn diagram over raster art.

### Glossary (auto-linked in lessons)
Specialised terms get definitions in **`backend/src/glossary/glossary.service.ts`**:
add to `SEED_TERMS` (`slug`, `termUk/En`, `defUk/En`, `category`, `courses: [key]`)
**and** to `TERM_MATCH` (the Ukrainian invariant stem, e.g. `альянс`, `емпаті`).
Only add **jargon** (terms with a specific psych meaning) — not everyday words.
Tagging with the course `key` populates that course's "Словник" section, and the
stem makes the term auto-link inline in lesson text.

## End-to-end workflow

1. **Scope** the course: audience, the 3–4 competencies it builds, how it ends
   ("by the end you can …"). One course = ~3 modules; module = 2–3 lessons +
   1 quiz + 1 practice.
2. **Research** every module's topic (steps 1–3 above). Keep a sources list.
3. **Outline**: modules + objectives + the lesson titles under each, mapped to
   the existing feedback signals where a practice checkpoint fits.
4. **Draft** each lesson to the quality bar (uk + en). Add figures where they
   earn their place; write the quiz; add new glossary terms + stems.
5. **Wire it in**: `SEED_COURSES` (course → modules → steps), glossary
   (`SEED_TERMS` + `TERM_MATCH`), any new figure `@case`.
6. **Verify**: `cd backend && npm run build`; `cd frontend && npm run build`.
   On boot the seed upserts. Ship as a PR; deploy; check the course renders
   (modules, objectives, figures, quiz, deepened lessons, glossary).
7. **Gate**: leave `published: false` until a licensed clinician reviews the
   content. Flip to `true` only after sign-off.

## Sourcing & safety (non-negotiable)
- Teach **public frameworks in our own words, with citations**. Never paste
  copyrighted text; no long quotes; summaries must be substantially original.
- Keep a short **sources list** per lesson (URLs / refs) in the PR description so
  the clinician can verify — even though learners don't see it.
- **Mandatory human clinical review before `published: true`.** AI-drafted
  clinical content is a draft, not an authority.
- Ukrainian-first, with the war/trauma context Reflect already serves; be
  trauma-informed and avoid harmful oversimplification of risk topics.

## Anti-patterns (what made earlier theory "куца")
- Writing from memory without researching → generic, thin, sometimes wrong.
- 3–4 short paragraphs and done → no steps, no example, no figure, no mistakes.
- Abstract description with no dialogue → learners can't see the skill in action.
- Jargon used but never defined / not added to the glossary.
- A quiz that only tests recall of a definition rather than judgement.
