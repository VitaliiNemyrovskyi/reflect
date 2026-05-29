import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  // Flagship clinical badges — awarded from synthesis `signals` (Phase 1b).
  // Only trip on sessions scored after the signals schema shipped.
  { key: 'quiet_signal', title: 'Тихий сигнал', description: 'Помітив пасивний суїцидальний сигнал і провів скринінг', category: 'safety', flagship: true },
  { key: 'drew_it_out', title: 'Витягнув приховане', description: 'Витягнув прихований між-сесійний шар', category: 'depth', flagship: true },
  { key: 'repaired', title: 'Полагодив', description: 'Помітив і відновив розрив альянсу', category: 'alliance', flagship: true },
  { key: 'safe_container', title: 'Безпечний контейнер', description: 'Травма-матеріал із заземленням, без ретравматизації', category: 'trauma', flagship: true },
  // difficulty lives in profileText (not a column), so this needs profile
  // parsing — deferred to Phase 1b alongside the skill-signal flagships.
  { key: 'tough_room', title: 'Складний кейс', description: 'Найскладніший пацієнт (5/5) з добрими оцінками', category: 'technique', comingSoon: true },
];

const RADAR_AXES = [
  { key: 'empathy', label: 'Емпатія' },
  { key: 'collaboration', label: 'Співпраця' },
  { key: 'guidedDiscovery', label: 'Скерований пошук' },
  { key: 'strategyForChange', label: 'Стратегія змін' },
] as const;

interface SessionRow {
  characterId: number;
  endedAt: Date | null;
  feedbackJson: string | null;
  character: { modality: string; lang: string; city: { key: string } | null };
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
  constructor(private readonly prisma: PrismaService) {}

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
    const meanCompetency = radar.length
      ? Math.round(radar.reduce((s, a) => s + a.allTime, 0) / radar.length)
      : 0;

    const badges = BADGES.map((b) => ({
      ...b,
      earned: earnedMap.has(b.key),
      earnedAt: earnedMap.get(b.key) ?? null,
    }));

    return {
      stage: this.computeStage(badges.filter((b) => b.earned).length, meanCompetency, sessions),
      meanCompetency,
      sessionsCompleted: sessions.length,
      radar,
      badges,
    };
  }

  // ── Radar ──────────────────────────────────────────────────────────────
  private computeRadar(assessments: Assessment[]) {
    const recent = assessments.slice(-8); // sessions are oldest→newest
    return RADAR_AXES.map((axis) => ({
      key: axis.key,
      label: axis.label,
      allTime: this.axisMean(assessments, axis.key),
      recent: this.axisMean(recent, axis.key),
    }));
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

  // ── Badge awarding (Tier-A, idempotent) ──────────────────────────────────
  private async awardTierA(userId: number, sessions: SessionRow[], assessments: Assessment[]) {
    if (sessions.length === 0) return;
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
      RADAR_AXES.every((ax) => (a.therapist?.[ax.key] ?? 0) >= v);
    if (assessments.some((a) => allAxesAtLeast(a, 4))) earn.push('well_rounded');
    if (assessments.some((a) => allAxesAtLeast(a, 5))) earn.push('flawless');

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

    // Idempotent insert. SQLite doesn't support createMany({ skipDuplicates }),
    // so we read the already-earned keys and only insert the diff. The
    // unique(userId,key) constraint is the real backstop against a race
    // between two concurrent reads — a duplicate insert there throws P2002,
    // which we swallow since it means the badge is already recorded.
    const already = new Set(
      (await this.prisma.userMilestone.findMany({ where: { userId }, select: { key: true } })).map(
        (m) => m.key,
      ),
    );
    const fresh = [...new Set(earn)].filter((key) => !already.has(key));
    if (fresh.length === 0) return;
    try {
      await this.prisma.userMilestone.createMany({ data: fresh.map((key) => ({ userId, key })) });
    } catch (err: unknown) {
      // P2002 = unique violation from a concurrent award; safe to ignore.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }

  /** Recent-half competency mean exceeds older-half by a clear margin. */
  private onTheRise(assessments: Assessment[]): boolean {
    if (assessments.length < 6) return false;
    const mid = Math.floor(assessments.length / 2);
    const meanOf = (arr: Assessment[]) => {
      const vals = arr.flatMap((a) =>
        RADAR_AXES.map((ax) => a.therapist?.[ax.key]).filter((v): v is number => typeof v === 'number'),
      );
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    };
    return meanOf(assessments.slice(mid)) - meanOf(assessments.slice(0, mid)) >= 0.5;
  }

  // ── Stage (un-rushable; Master needs flagship badges from Phase 1b) ──────
  private computeStage(earnedCount: number, meanCompetency: number, sessions: SessionRow[]): string {
    const mods = new Set(sessions.map((s) => s.character.modality)).size;
    // Counts are calibrated against the ~19 awardable badges. The competency +
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
        character: { select: { modality: true, lang: true, city: { select: { key: true } } } },
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
