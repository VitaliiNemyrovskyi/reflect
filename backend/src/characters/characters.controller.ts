import { Controller, Get, NotFoundException, Param, ParseIntPipe } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

interface AssessmentJson {
  patient?: Record<string, number | null>;
  therapist?: Record<string, number | null>;
  patientMemory?: string;
}

interface SessionSummary {
  id: number;
  startedAt: Date;
  endedAt: Date | null;
  messageCount: number;
  noteCount: number;
  assessment: AssessmentJson | null;
  feedbackPreview: string | null;
}

interface ProgressTrend {
  metric: string;
  series: { sessionId: number; value: number | null; date: string }[];
}

@Controller('characters')
export class CharactersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const userId = user.id;
    const characters = await this.prisma.character.findMany({
      orderBy: { id: 'asc' },
    });

    const enriched = await Promise.all(
      characters.map(async (c) => {
        const sessions = userId
          ? await this.prisma.session.findMany({
              where: { characterId: c.id, userId },
              orderBy: { startedAt: 'desc' },
            })
          : [];
        const completed = sessions.filter((s) => s.endedAt && s.feedbackJson);
        const trend = this.computePatientStateTrend(completed.slice(0, 3));
        return {
          id: c.id,
          slug: c.slug,
          displayName: c.displayName,
          diagnosis: c.diagnosis,
          diagnosisCode: c.diagnosisCode,
          difficulty: c.difficulty,
          complexity: c.complexity,
          avatarUrl: c.avatarUrl,
          summary: this.briefSummary(c.profileText),
          sessionCount: sessions.length,
          completedCount: completed.length,
          lastSessionAt: sessions[0]?.startedAt ?? null,
          progressBadge: trend,
        };
      }),
    );
    return enriched;
  }

  @Get(':id/full')
  async patientCard(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    const userId = user.id;
    const character = await this.prisma.character.findUnique({ where: { id } });
    if (!character) throw new NotFoundException('character not found');

    const sessions = await this.prisma.session.findMany({
      where: { characterId: id, userId },
      orderBy: { startedAt: 'desc' },
      include: {
        _count: { select: { messages: true, notes: true } },
      },
    });

    const sessionSummaries: SessionSummary[] = sessions.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      messageCount: s._count.messages,
      noteCount: s._count.notes,
      assessment: this.parseAssessment(s.feedbackJson),
      feedbackPreview: s.feedback ? this.previewFeedback(s.feedback) : null,
    }));

    // All notes across all sessions for this character + user
    const sessionIds = sessions.map((s) => s.id);
    const allNotes = sessionIds.length
      ? await this.prisma.note.findMany({
          where: { sessionId: { in: sessionIds } },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    const trends = this.computeTrends(sessionSummaries);
    const progressBadge = this.computePatientStateTrend(
      sessions.filter((s) => s.endedAt && s.feedbackJson).slice(0, 3),
    );
    const recentFeedback = sessions.find((s) => s.feedback)?.feedback ?? null;

    return {
      id: character.id,
      slug: character.slug,
      displayName: character.displayName,
      diagnosis: character.diagnosis,
      diagnosisCode: character.diagnosisCode,
      difficulty: character.difficulty,
      complexity: character.complexity,
      avatarUrl: character.avatarUrl,
      profileText: character.profileText,
      progressBadge,
      sessionCount: sessions.length,
      completedCount: sessions.filter((s) => s.endedAt).length,
      sessions: sessionSummaries,
      notes: allNotes,
      trends,
      recentFeedback,
    };
  }

  private parseAssessment(json: string | null): AssessmentJson | null {
    if (!json) return null;
    try {
      return JSON.parse(json) as AssessmentJson;
    } catch {
      return null;
    }
  }

  private previewFeedback(feedback: string): string {
    // Strip markdown headers, take first ~250 chars
    const stripped = feedback
      .replace(/^#+\s.*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return stripped.length > 250 ? stripped.slice(0, 247) + '…' : stripped;
  }

  private briefSummary(profileText: string): string {
    // Try to extract section "1. Базові відомості" lines, or first paragraph
    const lines = profileText.split('\n').filter((l) => l.trim());
    for (const l of lines) {
      const match = l.match(/^[-*]\s*(?:Вік|Age):\s*(.+)$/i);
      if (match) {
        // Build "Age, City, Profession" from nearby lines
        const ageL = lines.find((x) => /^[-*]\s*(?:Вік|Age):/i.test(x));
        const cityL = lines.find((x) => /^[-*]\s*(?:Місто|City)/i.test(x));
        const jobL = lines.find((x) => /^[-*]\s*(?:Робота|Профес|Job|Profession)/i.test(x));
        return [ageL, cityL, jobL]
          .filter(Boolean)
          .map((x) => x!.replace(/^[-*]\s*/, '').replace(/^[^:]+:\s*/, ''))
          .join(' • ');
      }
    }
    // Fallback: first non-quote line
    const firstParagraph = lines.find((l) => !l.startsWith('>') && !l.startsWith('#') && l.length > 30);
    return firstParagraph?.slice(0, 120) ?? '';
  }

  private computeTrends(sessions: SessionSummary[]): ProgressTrend[] {
    // Sessions are sorted DESC; reverse for chronological trend
    const chrono = [...sessions].reverse().filter((s) => s.assessment);
    if (chrono.length === 0) return [];

    const patientMetrics = ['symptomSeverity', 'insight', 'alliance', 'defensiveness', 'hopefulness'] as const;
    const therapistMetrics = ['empathy', 'collaboration', 'guidedDiscovery', 'strategyForChange'] as const;

    const trends: ProgressTrend[] = [];
    for (const m of patientMetrics) {
      trends.push({
        metric: `patient.${m}`,
        series: chrono.map((s) => ({
          sessionId: s.id,
          value: s.assessment?.patient?.[m] ?? null,
          date: s.startedAt.toISOString(),
        })),
      });
    }
    for (const m of therapistMetrics) {
      trends.push({
        metric: `therapist.${m}`,
        series: chrono.map((s) => ({
          sessionId: s.id,
          value: s.assessment?.therapist?.[m] ?? null,
          date: s.startedAt.toISOString(),
        })),
      });
    }
    return trends;
  }

  private computePatientStateTrend(
    recentSessions: { feedbackJson: string | null }[],
  ): 'improving' | 'stable' | 'worsening' | 'unknown' {
    const points = recentSessions
      .map((s) => this.parseAssessment(s.feedbackJson))
      .filter((a): a is AssessmentJson => a !== null && a.patient !== undefined);
    if (points.length < 2) return 'unknown';

    // "Better" = lower symptomSeverity & defensiveness, higher insight & alliance & hopefulness
    const score = (a: AssessmentJson): number | null => {
      const p = a.patient;
      if (!p) return null;
      const sev = p.symptomSeverity ?? null;
      const def = p.defensiveness ?? null;
      const ins = p.insight ?? null;
      const all = p.alliance ?? null;
      const hope = p.hopefulness ?? null;
      const positive = [ins, all, hope].filter((x): x is number => x !== null);
      const negative = [sev, def].filter((x): x is number => x !== null);
      if (positive.length === 0 && negative.length === 0) return null;
      const posAvg = positive.length ? positive.reduce((a, b) => a + b, 0) / positive.length : 5;
      const negAvg = negative.length ? negative.reduce((a, b) => a + b, 0) / negative.length : 5;
      // Positive trend = high posAvg + low negAvg → score ranges roughly 0..10
      return posAvg - (negAvg - 5);
    };

    // Sessions are DESC; latest first. Compare latest to earliest of the window.
    const latest = score(points[0]);
    const earliest = score(points[points.length - 1]);
    if (latest === null || earliest === null) return 'unknown';
    const delta = latest - earliest;
    if (delta > 1.0) return 'improving';
    if (delta < -1.0) return 'worsening';
    return 'stable';
  }
}
