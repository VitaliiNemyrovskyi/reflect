import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';

@Injectable()
export class CohortService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly progress: ProgressService,
  ) {}

  /** 6-char invite code from an unambiguous alphabet (no I/O/0/1). */
  private genCode(): string {
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(6);
    let s = '';
    for (let i = 0; i < 6; i++) s += alpha[bytes[i] % alpha.length];
    return s;
  }

  /** Create a cohort. Only users granted the instructor role may. */
  async createCohort(ownerId: number, name: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { isInstructor: true },
    });
    if (!owner?.isInstructor) {
      throw new ForbiddenException('Лише інструктор може створювати групи.');
    }
    const clean = (name ?? '').trim().slice(0, 80) || 'Без назви';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const c = await this.prisma.cohort.create({
          data: { name: clean, ownerId, inviteCode: this.genCode() },
        });
        return { id: c.id, name: c.name, inviteCode: c.inviteCode };
      } catch (err: unknown) {
        // Unique collision on inviteCode — retry with a fresh code.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new BadRequestException('Не вдалося згенерувати код. Спробуйте ще раз.');
  }

  /** Join a cohort by its invite code (any user can be a student). */
  async joinByCode(userId: number, code: string) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { inviteCode: (code ?? '').trim().toUpperCase() },
      select: { id: true, name: true, ownerId: true },
    });
    if (!cohort) throw new NotFoundException('Групу за таким кодом не знайдено.');
    if (cohort.ownerId === userId) {
      throw new BadRequestException('Це ваша власна група.');
    }
    await this.prisma.cohortMember.upsert({
      where: { cohortId_userId: { cohortId: cohort.id, userId } },
      create: { cohortId: cohort.id, userId },
      update: {},
    });
    return { id: cohort.id, name: cohort.name };
  }

  /** Cohorts the user owns (instructor) + cohorts they're a student in. */
  async listMine(userId: number) {
    const owned = await this.prisma.cohort.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        inviteCode: true,
        _count: { select: { members: true } },
      },
    });
    const memberships = await this.prisma.cohortMember.findMany({
      where: { userId },
      orderBy: { joinedAt: 'desc' },
      select: {
        shareSessions: true,
        cohort: {
          select: { id: true, name: true, owner: { select: { displayName: true, email: true } } },
        },
      },
    });
    return {
      owned: owned.map((c) => ({
        id: c.id,
        name: c.name,
        inviteCode: c.inviteCode,
        memberCount: c._count.members,
      })),
      joined: memberships.map((m) => ({
        id: m.cohort.id,
        name: m.cohort.name,
        instructor: m.cohort.owner.displayName ?? m.cohort.owner.email,
        shareSessions: m.shareSessions,
      })),
    };
  }

  /** Cohort detail with members' progress — owner (instructor) only. */
  async getCohortForOwner(ownerId: number, cohortId: number) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      select: {
        id: true,
        name: true,
        inviteCode: true,
        ownerId: true,
        members: { select: { userId: true, shareSessions: true } },
      },
    });
    if (!cohort) throw new NotFoundException('Групу не знайдено.');
    if (cohort.ownerId !== ownerId) {
      throw new ForbiddenException('Це не ваша група.');
    }
    const shareMap = new Map(cohort.members.map((m) => [m.userId, m.shareSessions]));
    const summaries = await this.progress.getCohortMemberSummaries(
      cohort.members.map((m) => m.userId),
    );
    // Tag each row with whether the student opted in to session-level
    // sharing (Phase 3) — drives the instructor drilldown affordance.
    const students = summaries.map((s) => ({
      ...s,
      sharing: shareMap.get(s.userId) ?? false,
    }));
    return { id: cohort.id, name: cohort.name, inviteCode: cohort.inviteCode, students };
  }

  /**
   * Student leaves a cohort (removes their own membership). Idempotent via
   * deleteMany — leaving a group you're not in is a no-op, not an error.
   */
  async leaveCohort(userId: number, cohortId: number) {
    await this.prisma.cohortMember.deleteMany({ where: { cohortId, userId } });
    return { left: true };
  }

  /**
   * Instructor removes a student from their own cohort. Owner-checked so
   * one instructor can't evict members from another's group. Idempotent.
   */
  async removeMember(ownerId: number, cohortId: number, memberUserId: number) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      select: { ownerId: true },
    });
    if (!cohort) throw new NotFoundException('Групу не знайдено.');
    if (cohort.ownerId !== ownerId) {
      throw new ForbiddenException('Це не ваша група.');
    }
    await this.prisma.cohortMember.deleteMany({
      where: { cohortId, userId: memberUserId },
    });
    return { removed: true };
  }

  /**
   * Instructor deletes their own cohort. Owner-checked. Memberships are
   * removed automatically by the onDelete: Cascade on CohortMember.cohort,
   * so a single delete is enough.
   */
  async deleteCohort(ownerId: number, cohortId: number) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      select: { ownerId: true },
    });
    if (!cohort) throw new NotFoundException('Групу не знайдено.');
    if (cohort.ownerId !== ownerId) {
      throw new ForbiddenException('Це не ваша група.');
    }
    await this.prisma.cohort.delete({ where: { id: cohortId } });
    return { deleted: true };
  }

  // ── Phase 3: session-level sharing (opt-in) ─────────────────────────────

  /**
   * Student sets their own session-sharing consent for one cohort. Must be
   * a member. Per-cohort + opt-in (default false): turning it on lets the
   * cohort owner open this student's transcripts + AI feedback.
   */
  async setConsent(userId: number, cohortId: number, share: boolean) {
    const res = await this.prisma.cohortMember.updateMany({
      where: { cohortId, userId },
      data: { shareSessions: share },
    });
    if (res.count === 0) throw new NotFoundException('Ви не є учасником цієї групи.');
    return { shareSessions: share };
  }

  /**
   * Guard for the instructor drilldown: caller must own the cohort, the
   * target must be a member, and that member must have opted in to sharing.
   */
  private async assertCanViewStudent(
    ownerId: number,
    cohortId: number,
    studentId: number,
  ) {
    const cohort = await this.prisma.cohort.findUnique({
      where: { id: cohortId },
      select: { ownerId: true },
    });
    if (!cohort) throw new NotFoundException('Групу не знайдено.');
    if (cohort.ownerId !== ownerId) throw new ForbiddenException('Це не ваша група.');
    const member = await this.prisma.cohortMember.findUnique({
      where: { cohortId_userId: { cohortId, userId: studentId } },
      select: { shareSessions: true },
    });
    if (!member) throw new NotFoundException('Студент не в цій групі.');
    if (!member.shareSessions) {
      throw new ForbiddenException('Студент не надав доступу до своїх сесій.');
    }
  }

  /** Instructor: list one consenting student's completed sessions. */
  async listStudentSessions(ownerId: number, cohortId: number, studentId: number) {
    await this.assertCanViewStudent(ownerId, cohortId, studentId);
    const sessions = await this.prisma.session.findMany({
      where: { userId: studentId, endedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        feedback: true,
        character: { select: { displayName: true } },
        _count: { select: { messages: true } },
      },
    });
    return sessions.map((s) => ({
      id: s.id,
      character: s.character?.displayName ?? '—',
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      messageCount: s._count.messages,
      hasFeedback: !!s.feedback,
    }));
  }

  /**
   * Instructor: full detail of one consenting student's session — transcript
   * + narrative feedback + structured assessment. Private working notes are
   * intentionally excluded (they stay the student's own).
   */
  async getStudentSession(
    ownerId: number,
    cohortId: number,
    studentId: number,
    sessionId: number,
  ) {
    await this.assertCanViewStudent(ownerId, cohortId, studentId);
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId: studentId },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        feedback: true,
        feedbackJson: true,
        character: { select: { displayName: true } },
        messages: {
          orderBy: { id: 'asc' },
          select: { role: true, content: true, createdAt: true },
        },
      },
    });
    if (!session) throw new NotFoundException('Сесію не знайдено.');
    return {
      id: session.id,
      character: session.character?.displayName ?? '—',
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      feedback: session.feedback ?? null,
      assessment: session.feedbackJson ? safeParse(session.feedbackJson) : null,
      messages: session.messages,
    };
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
