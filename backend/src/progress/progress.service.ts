import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { computeWellbeing, patientStateScore } from '../dashboard/wellbeing';

/**
 * Gamification progress (Phase 1a). Everything here is derived from data we
 * already persist — per-session `feedbackJson` (the assessment scores) plus
 * character metadata. The ONLY stored state is earned badges (UserMilestone),
 * awarded idempotently on read.
 *
 * Phase 1a deliberately covers only what persisted data supports cleanly:
 *   - radar from the 4 therapist competency scores (empathy / collaboration /
 *     guidedDiscovery / strategyForChange)
 *   - the 8 "Tier-A" badges computable from assessment + session metadata.
 * The flagship skill-signal badges (quiet_signal, drew_it_out, repaired,
 * full_intake, safe_container) and the 4 skill-derived radar axes need
 * per-skill signals, which aren't persisted yet — they arrive in Phase 1b.
 */

const ALL_CITIES = ['kyiv', 'london', 'paris'];
const ALL_MODALITIES = ['individual', 'couples', 'family', 'adolescent', 'crisis'];
const ALL_LANGS = ['uk', 'en', 'fr'];

export interface BadgeDef {
  key: string;
  title: string;
  description: string;
  category: 'safety' | 'alliance' | 'technique' | 'depth' | 'trauma' | 'breadth' | 'growth';
  flagship?: boolean;
  /** Phase 1a can't award these yet (need skill signals) — shown as goals. */
  comingSoon?: boolean;
}

/** Catalog. Order = display order. */
export const BADGES: BadgeDef[] = [
  { key: 'first_contact', title: 'Контакт', description: 'Перша завершена сесія з фідбеком', category: 'alliance' },
  { key: 'attuned', title: 'Налаштований', description: 'Емпатія 5+ в одній сесії', category: 'alliance' },
  { key: 'stayed_course', title: 'Не покинув', description: '5+ сесій з одним пацієнтом', category: 'breadth' },
  { key: 'three_cities', title: 'Три міста', description: 'Сесії в Києві, Лондоні й Парижі', category: 'breadth' },
  { key: 'full_palette', title: 'Уся палітра', description: 'Сесії в усіх 5 модальностях', category: 'breadth' },
  { key: 'polyglot', title: 'Поліглот', description: 'Сесії трьома мовами', category: 'breadth' },
  { key: 'on_the_rise', title: 'На підйомі', description: 'Зростання компетенції за останній період', category: 'growth' },
  // ── Volume / стаж ──
  { key: 'finding_feet', title: 'Перші кроки', description: '5 завершених сесій', category: 'growth' },
  { key: 'seasoned', title: 'Набита рука', description: '25 завершених сесій', category: 'growth' },
  { key: 'centurion', title: 'Сотня', description: '100 завершених сесій', category: 'growth' },
  // ── Техніка (оцінки терапевта 0-6 в одній сесії) ──
  { key: 'deep_listener', title: 'Глибоке слухання', description: 'Скерований пошук 5+ в одній сесії', category: 'depth' },
  { key: 'collaborator', title: 'Союз', description: 'Співпраця 5+ в одній сесії', category: 'alliance' },
  { key: 'change_agent', title: 'Агент змін', description: 'Стратегія змін 5+ в одній сесії', category: 'technique' },
  { key: 'well_rounded', title: 'Рівновага', description: 'Усі чотири компетенції 4+ в одній сесії', category: 'technique' },
  { key: 'flawless', title: 'Бездоганна сесія', description: 'Усі чотири компетенції 5+ в одній сесії', category: 'technique' },
  // ── Результат для пацієнта (динаміка стану від першої до останньої сесії) ──
  { key: 'breakthrough', title: 'Прорив', description: 'Інсайт пацієнта помітно зріс за курс сесій', category: 'depth' },
  { key: 'symptom_relief', title: 'Полегшення', description: 'Симптоматика пацієнта помітно спала за курс сесій', category: 'growth' },
  // ── Широта / залученість ──
  { key: 'roster_of_ten', title: 'Десять облич', description: 'Сесії з 10 різними пацієнтами', category: 'breadth' },
  { key: 'weekender', title: 'І в вихідні', description: 'Сесія у суботу або неділю', category: 'growth' },
  { key: 'comeback', title: 'Повернення', description: 'Відновив роботу з пацієнтом після тривалої перерви', category: 'alliance' },
  // Flagship clinical badges — awarded from synthesis `signals` (Phase 1b).
  // Only trip on sessions scored after the signals schema shipped.
  { key: 'quiet_signal', title: 'Тихий сигнал', description: 'Помітив пасивний суїцидальний сигнал і провів скринінг', category: 'safety', flagship: true },
  { key: 'drew_it_out', title: 'Витягнув приховане', description: 'Витягнув прихований між-сесійний шар', category: 'depth', flagship: true },
  { key: 'repaired', title: 'Полагодив', description: 'Помітив і відновив розрив альянсу', category: 'alliance', flagship: true },
  { key: 'safe_container', title: 'Безпечний контейнер', description: 'Травма-матеріал із заземленням, без ретравматизації', category: 'trauma', flagship: true },
  { key: 'tough_room', title: 'Складний кейс', description: 'Найскладніший пацієнт (5/5) з добрими оцінками', category: 'technique' },
];

// Core competencies — present on EVERY scored session. Drive meanCompetency,
// the stage gate, and the well_rounded/flawless/on_the_rise badges. Stable.
const CORE_AXES = [
  { key: 'empathy', label: 'Емпатія' },
  { key: 'collaboration', label: 'Співпраця' },
  { key: 'guidedDiscovery', label: 'Скерований пошук' },
  { key: 'strategyForChange', label: 'Стратегія змін' },
] as const;
// Extended competencies — scored from Phase 1b onward (CTS-R-derived). The
// radar grows from 4 → 8 axes once a user has at least one session carrying
// these, so existing users keep a clean 4-axis radar until their next session.
const EXT_AXES = [
  { key: 'structure', label: 'Структура' },
  { key: 'pacing', label: 'Темп' },
  { key: 'formulation', label: 'Формулювання' },
  { key: 'homework', label: 'Закріплення' },
] as const;
const RADAR_AXES = [...CORE_AXES, ...EXT_AXES] as const;

/** Keys of the flagship clinical badges — gate the Майстер stage. */
const FLAGSHIP_KEYS = new Set(['quiet_signal', 'drew_it_out', 'repaired', 'safe_container']);

// Specialisation tracks (§3.4 Layer 2) — the horizontal, endless "what's next".
// Keyed on modality (3 of the design's 5 specialisations are modalities;
// theme tracks like Trauma/Grief need theme tagging → later). A track levels
// up on STRONG sessions (core competency ≥4/6) in that modality.
const MODALITY_LABELS: Record<string, string> = {
  individual: 'Індивідуальна',
  couples: 'Парна',
  family: 'Сімейна',
  adolescent: 'Підліткова',
  crisis: 'Кризова',
};
const SPEC_TIERS = [3, 8, 16]; // strong-session thresholds for tiers 1/2/3
const SPEC_TIER_LABELS = ['Перші кроки', 'Знайомство', 'Впевнено', 'Спеціаліст'];

interface SessionRow {
  characterId: number;
  endedAt: Date | null;
  feedbackJson: string | null;
  character: { modality: string; lang: string; difficulty: number | null; city: { key: string } | null };
}

interface Assessment {
  therapist?: Partial<Record<(typeof RADAR_AXES)[number]['key'], number | null>>;
  /** Patient-state scores, 1-10. Direction (per characters.controller): lower
   *  symptomSeverity/defensiveness = better; higher insight/alliance/hopefulness
   *  = better. Used by the outcome-arc badges (breakthrough / symptom_relief). */
  patient?: {
    symptomSeverity?: number | null;
    insight?: number | null;
    alliance?: number | null;
    defensiveness?: number | null;
    hopefulness?: number | null;
  };
  /** Clinical-event flags the synthesis sets when a flagship-worthy moment
   *  genuinely happened (Phase 1b). Only present on sessions scored after the
   *  schema shipped — older sessions simply never trip the flagship badges. */
  signals?: {
    riskScreened?: boolean;
    hiddenLayerReached?: boolean;
    ruptureRepaired?: boolean;
    traumaGrounded?: boolean;
  };
}

@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /**
   * Full progress payload for a user. Recomputes badge awards on the way
   * (idempotent), so opening the page keeps milestones current without any
   * feedback-write-path coupling.
   */
  async getProgress(userId: number) {
    const sessions = await this.loadScoredSessions(userId);
    const assessments = sessions
      .map((s) => this.parse(s.feedbackJson))
      .filter((a): a is Assessment => a !== null);

    await this.awardTierA(userId, sessions, assessments);

    const earned = await this.prisma.userMilestone.findMany({
      where: { userId },
      select: { key: true, earnedAt: true },
    });
    const earnedMap = new Map(earned.map((e) => [e.key, e.earnedAt]));

    const radar = this.computeRadar(assessments);
    // meanCompetency is pinned to the CORE axes (present on every session), so
    // the headline number + stage gate stay stable when the radar expands to 8.
    const meanCompetency = Math.round(
      CORE_AXES.reduce((s, ax) => s + this.axisMean(assessments, ax.key), 0) / CORE_AXES.length,
    );

    const badges = BADGES.map((b) => ({
      ...b,
      earned: earnedMap.has(b.key),
      earnedAt: earnedMap.get(b.key) ?? null,
    }));

    return {
      stage: this.computeStage(
        badges.filter((b) => b.earned).length,
        badges.filter((b) => b.earned && b.flagship).length,
        meanCompetency,
        sessions,
      ),
      meanCompetency,
      sessionsCompleted: sessions.length,
      radar,
      specialisations: this.computeSpecialisations(sessions),
      badges,
    };
  }

  /**
   * Admin-only therapist board (design §14). One summary row per user who has
   * practised (≥1 scored session). Read-only — reuses earnedKeys (no award
   * side-effect) and derives caseload health from each patient's last-session
   * wellbeing. Sorted by PRACTICE VOLUME (engagement), never by clinical score:
   * this is oversight + a future-directory seed, not a quality leaderboard
   * (Principle #2). Beta-scale loop (one query per user) — fine for now.
   */
  async getAdminBoard() {
    const users = await this.prisma.user.findMany({
      select: { id: true, email: true, displayName: true, isAdmin: true },
    });
    const rows = [];
    for (const u of users) {
      const row = await this.summarizeUser(u);
      if (row) rows.push(row); // admin board skips users who never practised
    }
    rows.sort((a, b) => b.sessionsCompleted - a.sessionsCompleted);
    return rows;
  }

  /**
   * Cohort board (instructor view) — per-member summary scoped to one group.
   * Unlike the admin board, students who haven't started yet ARE included
   * (a zero-row), so the instructor sees who hasn't begun. Sorted by name —
   * a private oversight list, not a competitive ranking (Principle #2).
   */
  async getCohortMemberSummaries(userIds: number[]) {
    if (userIds.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, displayName: true, isAdmin: true },
    });
    const awardable = BADGES.filter((b) => !b.comingSoon).length;
    const rows = [];
    for (const u of users) {
      const row = await this.summarizeUser(u);
      rows.push(
        row ?? {
          userId: u.id,
          email: u.email,
          displayName: u.displayName,
          isAdmin: u.isAdmin,
          stage: 'Стажер',
          meanCompetency: 0,
          sessionsCompleted: 0,
          badgeCount: 0,
          awardableCount: awardable,
          patients: 0,
          lapsed: 0,
          lastActiveAt: null as Date | null,
        },
      );
    }
    rows.sort((a, b) =>
      (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email, 'uk'),
    );
    return rows;
  }

  /** One progress-summary row for a user. null when they've never practised. */
  private async summarizeUser(u: {
    id: number;
    email: string;
    displayName: string | null;
    isAdmin: boolean;
  }) {
    const sessions = await this.loadScoredSessions(u.id);
    if (sessions.length === 0) return null;
    const assessments = sessions
      .map((s) => this.parse(s.feedbackJson))
      .filter((a): a is Assessment => a !== null);
    const meanCompetency = Math.round(
      CORE_AXES.reduce((s, ax) => s + this.axisMean(assessments, ax.key), 0) / CORE_AXES.length,
    );
    const earned = this.earnedKeys(sessions, assessments);

    // Caseload health: last scored session per patient → count lapsed meters.
    const now = new Date();
    const lastByPatient = new Map<number, SessionRow>();
    for (const s of sessions) lastByPatient.set(s.characterId, s);
    let lapsed = 0;
    for (const s of lastByPatient.values()) {
      if (!s.endedAt) continue;
      const patient = this.parse(s.feedbackJson)?.patient ?? null;
      const wb = computeWellbeing(patientStateScore(patient), s.endedAt, now);
      if (wb?.stage === 'lapsed') lapsed++;
    }

    return {
      userId: u.id,
      email: u.email,
      displayName: u.displayName,
      isAdmin: u.isAdmin,
      stage: this.computeStage(
        earned.length,
        earned.filter((k) => FLAGSHIP_KEYS.has(k)).length,
        meanCompetency,
        sessions,
      ),
      meanCompetency,
      sessionsCompleted: sessions.length,
      badgeCount: earned.length,
      awardableCount: BADGES.filter((b) => !b.comingSoon).length,
      patients: lastByPatient.size,
      lapsed,
      lastActiveAt: sessions[sessions.length - 1].endedAt as Date | null,
    };
  }

  // ── Radar ──────────────────────────────────────────────────────────────
  // Adaptive: 8 axes once any session carries the extended (Phase-1b) scores,
  // otherwise the original clean 4. The frontend renders whatever N it gets.
  private computeRadar(assessments: Assessment[]) {
    const recent = assessments.slice(-8); // sessions are oldest→newest
    const hasExtended = assessments.some((a) =>
      EXT_AXES.some((ax) => typeof a.therapist?.[ax.key] === 'number'),
    );
    const axes = hasExtended ? RADAR_AXES : CORE_AXES;
    return axes.map((axis) => ({
      key: axis.key,
      label: axis.label,
      allTime: this.axisMean(assessments, axis.key),
      recent: this.axisMean(recent, axis.key),
    }));
  }

  // ── Specialisation tracks (§3.4 Layer 2) ────────────────────────────────
  /** Per-modality progression: a track levels up on STRONG sessions (core
   *  therapist mean ≥4/6) in that modality. Sorted most-developed first. */
  private computeSpecialisations(sessions: SessionRow[]) {
    const byMod = new Map<string, { total: number; strong: number }>();
    for (const s of sessions) {
      const mod = s.character.modality;
      const rec = byMod.get(mod) ?? { total: 0, strong: 0 };
      rec.total++;
      const a = this.parse(s.feedbackJson);
      if (a) {
        const vals = CORE_AXES.map((ax) => a.therapist?.[ax.key]).filter(
          (v): v is number => typeof v === 'number',
        );
        const mean = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
        if (mean >= 4) rec.strong++;
      }
      byMod.set(mod, rec);
    }
    return [...byMod.entries()]
      .map(([key, rec]) => {
        let tier = 0;
        for (let i = 0; i < SPEC_TIERS.length; i++) if (rec.strong >= SPEC_TIERS[i]) tier = i + 1;
        return {
          key,
          label: MODALITY_LABELS[key] ?? key,
          sessions: rec.total,
          strong: rec.strong,
          tier,
          tierLabel: SPEC_TIER_LABELS[tier],
          nextAt: tier < SPEC_TIERS.length ? SPEC_TIERS[tier] : null,
        };
      })
      .sort((a, b) => b.strong - a.strong || b.sessions - a.sessions);
  }

  /** Mean of a 0-6 therapist score across assessments, normalised to 0-100. */
  private axisMean(assessments: Assessment[], key: (typeof RADAR_AXES)[number]['key']): number {
    const vals = assessments
      .map((a) => a.therapist?.[key])
      .filter((v): v is number => typeof v === 'number');
    if (vals.length === 0) return 0;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return Math.round((mean / 6) * 100);
  }

  // ── Badge computation ────────────────────────────────────────────────────
  /**
   * The set of badge keys a user's sessions currently earn. No persistence —
   * awardTierA wraps this to store the diff, and the admin board reuses it for
   * accurate counts without any write side-effect.
   */
  private earnedKeys(sessions: SessionRow[], assessments: Assessment[]): string[] {
    if (sessions.length === 0) return [];
    const earn: string[] = ['first_contact'];

    if (assessments.some((a) => (a.therapist?.empathy ?? 0) >= 5)) earn.push('attuned');

    const cities = new Set(sessions.map((s) => s.character.city?.key).filter(Boolean));
    if (ALL_CITIES.every((c) => cities.has(c))) earn.push('three_cities');

    const mods = new Set(sessions.map((s) => s.character.modality));
    if (ALL_MODALITIES.every((m) => mods.has(m))) earn.push('full_palette');

    const langs = new Set(sessions.map((s) => s.character.lang));
    if (ALL_LANGS.every((l) => langs.has(l))) earn.push('polyglot');

    const perPair = new Map<number, number>();
    for (const s of sessions) perPair.set(s.characterId, (perPair.get(s.characterId) ?? 0) + 1);
    if ([...perPair.values()].some((n) => n >= 5)) earn.push('stayed_course');

    if (this.onTheRise(assessments)) earn.push('on_the_rise');

    // ── Volume / стаж ──
    if (sessions.length >= 5) earn.push('finding_feet');
    if (sessions.length >= 25) earn.push('seasoned');
    if (sessions.length >= 100) earn.push('centurion');

    // ── Single-session technique peaks (therapist 0-6) ──
    if (assessments.some((a) => (a.therapist?.guidedDiscovery ?? 0) >= 5)) earn.push('deep_listener');
    if (assessments.some((a) => (a.therapist?.collaboration ?? 0) >= 5)) earn.push('collaborator');
    if (assessments.some((a) => (a.therapist?.strategyForChange ?? 0) >= 5)) earn.push('change_agent');
    const allAxesAtLeast = (a: Assessment, v: number) =>
      CORE_AXES.every((ax) => (a.therapist?.[ax.key] ?? 0) >= v);
    if (assessments.some((a) => allAxesAtLeast(a, 4))) earn.push('well_rounded');
    if (assessments.some((a) => allAxesAtLeast(a, 5))) earn.push('flawless');

    // ── Tough room: solid work (all 4 core ≥4) with a max-difficulty (5/5)
    // patient. difficulty is a real Character column (behavioural 1-5). ──
    const toughRoom = sessions.some((s) => {
      if (s.character.difficulty !== 5) return false;
      const a = this.parse(s.feedbackJson);
      return a ? allAxesAtLeast(a, 4) : false;
    });
    if (toughRoom) earn.push('tough_room');

    // ── Breadth / engagement ──
    if (perPair.size >= 10) earn.push('roster_of_ten');
    // endedAt is stored UTC; day-of-week is timezone-robust enough for a
    // playful badge (a few hours' offset never crosses a whole weekend).
    if (sessions.some((s) => s.endedAt && (s.endedAt.getUTCDay() === 0 || s.endedAt.getUTCDay() === 6)))
      earn.push('weekender');

    // ── Patient-outcome arcs (first→last per patient, 1-10 scale) ──
    // sessions are ordered endedAt asc, so per-patient arrays stay chronological.
    const byPatient = new Map<number, Assessment[]>();
    for (const s of sessions) {
      const a = this.parse(s.feedbackJson);
      if (!a) continue;
      const arr = byPatient.get(s.characterId);
      if (arr) arr.push(a);
      else byPatient.set(s.characterId, [a]);
    }
    for (const arr of byPatient.values()) {
      if (arr.length < 2) continue;
      const first = arr[0].patient;
      const last = arr[arr.length - 1].patient;
      const fi = first?.insight;
      const li = last?.insight;
      if (typeof fi === 'number' && typeof li === 'number' && li - fi >= 3 && li >= 7)
        earn.push('breakthrough');
      const fs = first?.symptomSeverity;
      const ls = last?.symptomSeverity;
      if (typeof fs === 'number' && typeof ls === 'number' && fs - ls >= 3 && ls <= 4)
        earn.push('symptom_relief');
    }

    // ── Flagship clinical signals (Phase 1b) ──
    // Synthesis sets these booleans when the moment genuinely happened. Any
    // single qualifying session earns the badge.
    if (assessments.some((a) => a.signals?.riskScreened)) earn.push('quiet_signal');
    if (assessments.some((a) => a.signals?.hiddenLayerReached)) earn.push('drew_it_out');
    if (assessments.some((a) => a.signals?.ruptureRepaired)) earn.push('repaired');
    if (assessments.some((a) => a.signals?.traumaGrounded)) earn.push('safe_container');

    // ── Win-back: re-engaged a patient after a ≥6-week lapse ──
    // Such a gap means the patient had gone cold (Tamagotchi "lapsed"); coming
    // back and rebuilding the alliance is the rewardable act (continuity-of-care).
    const SIX_WEEKS_MS = 6 * 7 * 24 * 60 * 60 * 1000;
    const timesByChar = new Map<number, number[]>();
    for (const s of sessions) {
      if (!s.endedAt) continue;
      const arr = timesByChar.get(s.characterId);
      if (arr) arr.push(s.endedAt.getTime());
      else timesByChar.set(s.characterId, [s.endedAt.getTime()]);
    }
    outer: for (const times of timesByChar.values()) {
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] >= SIX_WEEKS_MS) {
          earn.push('comeback');
          break outer;
        }
      }
    }

    return [...new Set(earn)];
  }

  // ── Badge awarding (idempotent persist of the earned diff) ───────────────
  private async awardTierA(userId: number, sessions: SessionRow[], assessments: Assessment[]) {
    const earn = this.earnedKeys(sessions, assessments);
    if (earn.length === 0) return;
    // SQLite doesn't support createMany({ skipDuplicates }), so read the
    // already-earned keys and insert only the diff. unique(userId,key) is the
    // backstop against a concurrent-award race — a dup insert throws P2002,
    // which we swallow since it means the badge is already recorded.
    const already = new Set(
      (await this.prisma.userMilestone.findMany({ where: { userId }, select: { key: true } })).map(
        (m) => m.key,
      ),
    );
    const fresh = earn.filter((key) => !already.has(key));
    if (fresh.length === 0) return;
    try {
      await this.prisma.userMilestone.createMany({ data: fresh.map((key) => ({ userId, key })) });
    } catch (err: unknown) {
      // P2002 = unique violation from a concurrent award; safe to ignore.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    // Notify the trainee that new badge(s) unlocked (in-app feed + push).
    // Fire-and-forget — awarding must not block on, or fail from, a notify.
    void this.notifyBadges(userId, fresh);
  }

  /** Badge-unlocked notification: mirrors to the in-app feed and pushes. */
  private async notifyBadges(userId: number, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      const titles = keys
        .map((k) => BADGES.find((b) => b.key === k)?.title)
        .filter((t): t is string => !!t);
      const list = titles.join(', ');
      const lang = await this.push.resolveLang(userId);
      const body =
        lang === 'en'
          ? `New milestone unlocked: ${list || 'a new badge'}. See your Progress.`
          : lang === 'fr'
            ? `Nouveau jalon débloqué : ${list || 'un badge'}. Voir votre Progression.`
            : `Нова віха відкрита: ${list || 'новий бейдж'} 🏅 Поглянь у «Прогрес».`;
      await this.push.sendToUser(userId, {
        title: 'Reflect',
        body,
        url: '/progress',
        tag: 'badge',
        type: 'badge',
      });
    } catch (e) {
      this.logger.warn(`badge notify failed: ${(e as Error).message}`);
    }
  }

  /** Recent-half competency mean exceeds older-half by a clear margin. */
  private onTheRise(assessments: Assessment[]): boolean {
    if (assessments.length < 6) return false;
    const mid = Math.floor(assessments.length / 2);
    const meanOf = (arr: Assessment[]) => {
      const vals = arr.flatMap((a) =>
        CORE_AXES.map((ax) => a.therapist?.[ax.key]).filter((v): v is number => typeof v === 'number'),
      );
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    };
    return meanOf(assessments.slice(mid)) - meanOf(assessments.slice(0, mid)) >= 0.5;
  }

  // ── Stage (un-rushable; Master needs flagship badges from Phase 1b) ──────
  private computeStage(
    earnedCount: number,
    flagshipCount: number,
    meanCompetency: number,
    sessions: SessionRow[],
  ): string {
    const mods = new Set(sessions.map((s) => s.character.modality)).size;
    // Майстер (Layer 1, §3.4) is deliberately un-rushable: it needs genuine
    // BREADTH (all 5 modalities) × clinical DEPTH (≥3 flagship badges — the
    // quiet signal, the rupture repair, etc.) × SUSTAINED quality (mean ≥75),
    // on top of a large badge count. You physically can't grind it in weeks
    // without covering the whole range. Beyond it, the journey continues
    // horizontally via specialisation tracks (Layer 2), not a ceiling.
    if (earnedCount >= 14 && flagshipCount >= 3 && mods >= 5 && meanCompetency >= 75) {
      return 'Майстер';
    }
    // Counts are calibrated against the awardable-badge pool. The competency +
    // modality-breadth gates are the real constraint — a grinder with many easy
    // volume badges but weak scores still can't pass meanCompetency.
    if (earnedCount >= 8 && mods >= 3 && meanCompetency >= 65) return 'Досвідчений';
    if (earnedCount >= 3 && meanCompetency >= 50) return 'Практик';
    return 'Стажер';
    // 'Майстер' intentionally unreachable until Phase 1b flagship badges
    // (breadth + sustained quality + clinical flagships) gate it.
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private async loadScoredSessions(userId: number): Promise<SessionRow[]> {
    return this.prisma.session.findMany({
      where: { userId, endedAt: { not: null }, feedbackJson: { not: null } },
      orderBy: { endedAt: 'asc' },
      select: {
        characterId: true,
        endedAt: true,
        feedbackJson: true,
        character: { select: { modality: true, lang: true, difficulty: true, city: { select: { key: true } } } },
      },
    });
  }

  private parse(json: string | null): Assessment | null {
    if (!json) return null;
    try {
      return JSON.parse(json) as Assessment;
    } catch {
      return null;
    }
  }
}
