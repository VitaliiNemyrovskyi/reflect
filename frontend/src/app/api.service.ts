import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService, type AuthResult, type AuthUser } from './auth.service';

export type ProgressBadge = 'improving' | 'stable' | 'worsening' | 'unknown';

/**
 * Therapy modality — backend's `modality` enum (string). See
 * backend/src/characters/modality.ts for the full catalog with labels +
 * descriptions; frontend fetches it via api.listModalities().
 */
export type ModalityKey =
  | 'individual'
  | 'couples'
  | 'family'
  | 'adolescent'
  | 'crisis';

export interface ModalityInfo {
  key: ModalityKey;
  label: string;
  short: string;
  icon: string;
  description: string;
}

export interface Character {
  id: number;
  slug: string;
  displayName: string;
  diagnosis?: string | null;     // Ukrainian-language label, shown directly on UI
  diagnosisCode?: string | null; // English DSM-5 / ICD code, shown as tooltip
  difficulty?: number | null;    // behavioral (Поведінка) — modulates LLM
  complexity?: number | null;    // clinical (Тяжкість) — informational
  modality?: ModalityKey;        // therapy modality — defaults to 'individual' server-side
  avatarUrl?: string | null;
  summary?: string;
  sessionCount?: number;
  completedCount?: number;
  lastSessionAt?: string | null;
  progressBadge?: ProgressBadge;
  createdById?: number | null;   // null = system patient (read-only for non-admins)
  isMine?: boolean;              // true if current user created this patient
}

/** Structured brief used by the patient creation form. */
export interface CharacterDraftBrief {
  displayName: string;
  gender: 'female' | 'male';
  age?: number;
  city?: string;
  profession?: string;
  diagnosis?: string;
  diagnosisCode?: string;
  difficulty?: number;
  complexity?: number;
  modality?: ModalityKey;
  brief?: string;
  hiddenLayerHint?: string;
  voiceNotes?: string;
  themes?: string[];
}

/**
 * Fields with per-field AI assist (✨ buttons). Excludes `gender` (binary
 * radio choice — no AI button) and `profileText` (handled separately by
 * the full-profile draft endpoint).
 */
export type DraftFieldName =
  | 'displayName'
  | 'age'
  | 'city'
  | 'profession'
  | 'diagnosis'
  | 'diagnosisCode'
  | 'difficulty'
  | 'complexity'
  | 'brief'
  | 'hiddenLayerHint'
  | 'voiceNotes'
  | 'themes';

/**
 * Response shape for per-field AI assist. `value` is typed loosely; the
 * caller dispatches by field name and coerces (number for age, string[]
 * for themes, string for everything else).
 */
export interface DraftFieldResult {
  value: string | number | string[];
}

export interface CreateCharacterDto {
  displayName: string;
  profileText: string;
  diagnosis?: string;
  diagnosisCode?: string;
  difficulty?: number;
  complexity?: number;
  modality?: ModalityKey;
  avatarUrl?: string;
}

/** Read-access grant entry returned by the shares endpoints. */
export interface CharacterShare {
  id: number;
  userId: number;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface AssessmentJson {
  patient?: {
    symptomSeverity?: number | null;
    insight?: number | null;
    alliance?: number | null;
    defensiveness?: number | null;
    hopefulness?: number | null;
  };
  therapist?: {
    empathy?: number | null;
    collaboration?: number | null;
    guidedDiscovery?: number | null;
    strategyForChange?: number | null;
  };
  patientMemory?: string;
}

export interface SessionSummary {
  id: number;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  noteCount: number;
  assessment: AssessmentJson | null;
  feedbackPreview: string | null;
  /** Patient's first-person memory of this session, surfaced on the
   *  detail page so the trainee can see what carries forward into
   *  the next session before opening it. */
  patientMemory: string | null;
}

export interface ProgressTrendPoint {
  sessionId: number;
  value: number | null;
  date: string;
}

export interface ProgressTrend {
  metric: string;
  series: ProgressTrendPoint[];
}

export interface PatientCard {
  id: number;
  slug: string;
  displayName: string;
  diagnosis: string | null;
  diagnosisCode: string | null;
  difficulty: number | null;
  complexity: number | null;
  modality: ModalityKey;
  avatarUrl: string | null;
  profileText: string;
  createdById: number | null;
  isMine: boolean;
  progressBadge: ProgressBadge;
  sessionCount: number;
  completedCount: number;
  sessions: SessionSummary[];
  notes: Note[];
  trends: ProgressTrend[];
  recentFeedback: string | null;
}

export interface StartSessionResponse {
  sessionId: number;
  character: { id: number; displayName: string };
  firstMessage: string;
}

export interface SendMessageResponse {
  reply: string;
}

export interface EndSessionResponse {
  feedback: string;
}

export interface SessionViewMessage {
  id: number;
  role: string;
  content: string;
  createdAt: string;
}

export interface SessionView {
  id: number;
  startedAt: string;
  endedAt: string | null;
  feedback: string | null;
  feedbackJson: string | null;
  patientMemory: string | null;
  character: { id: number; displayName: string; slug: string; avatarUrl: string | null };
  messages: SessionViewMessage[];
  notes: Note[];
  /** Tests administered during this session — rendered inline as
   *  result cards in /session/:id/view. Backend parses answersJson
   *  ahead of time so the template loop stays simple. */
  tests: SessionTest[];
  assessment: AssessmentJson | null;
}

export type FeedbackStreamEvent =
  | { type: 'cached'; data: { feedback: string; assessment: AssessmentJson | null } }
  | { type: 'chunk'; data: { text: string } }
  | { type: 'progress'; data: { stage: string; message: string } }
  | { type: 'done'; data: { feedback: string; assessment: AssessmentJson | null } }
  | { type: 'error'; data: { message: string } };

export interface Note {
  id: number;
  sessionId: number;
  anchorMessageId: number | null;
  anchorText: string | null;
  noteText: string;
  createdAt: string;
}

export interface CreateNoteInput {
  noteText: string;
  anchorMessageId?: number;
  anchorText?: string;
}

export type HintKind =
  | 'open-question'
  | 'reflection'
  | 'summary'
  | 'screening'
  | 'here-and-now'
  | 'psychoeducation'
  | 'closing'
  | 'other';

export interface HintSuggestion {
  text: string;
  rationale: string;
  kind: HintKind;
}

export interface HintResult {
  suggestions: HintSuggestion[];
}

// ─── Psychological tests ──────────────────────────────────────────────────

export interface TestOption {
  value: number;
  labelUa: string;
}

export interface TestItem {
  id: number;
  constructUa: string;
  reverse?: boolean;
  options?: TestOption[];
}

export interface InterpretationBand {
  min: number;
  max: number;
  level: string;
  labelUa: string;
  color: 'good' | 'neutral' | 'warn' | 'danger';
}

/** Catalog-list item — items array stripped to keep the response small. */
export interface PsychTestSummary {
  key: string;
  name: string;
  fullName: string;
  fullNameUa: string;
  description: string;
  descriptionUa: string;
  domain: string;
  ageGroup: string;
  itemCount: number;
  timeMinutes: number;
  scoreRange: [number, number];
  source: string;
  tags: string[];
}

export interface PsychTest extends PsychTestSummary {
  instructionUa: string;
  options: TestOption[];
  items: TestItem[];
  interpretation: InterpretationBand[];
  interpretationScale?: 'raw' | 'scaled';
  scaledScoreRange?: [number, number];
  scoreFormula?: string;
  clinicalCutoff?: number;
  specialFlags?: Array<{ condition: string; labelUa: string }>;
}

/** One answer in a completed session-test. constructUa is denormalised
 *  from the test catalog so the result card can render without an
 *  extra getPsychTest() fetch. */
export interface SessionTestAnswer {
  itemId: number;
  value: number;
  optionLabel: string;
  constructUa: string;
}

/** Result of administering a test in a specific session. */
export interface SessionTest {
  id: number;
  sessionId: number;
  testKey: string;
  status: 'pending' | 'completed' | 'failed';
  answers?: SessionTestAnswer[] | null;
  answersJson?: string | null;
  rawScore: number | null;
  scaledScore: number | null;
  severity: string | null;
  severityLabel: string | null;
  aiAnalysis: string | null;
  requestedAt: string;
  completedAt: string | null;
}

// ─── Admin types ──────────────────────────────────────────────────────────

export interface AdminUser {
  id: number;
  email: string;
  displayName: string | null;
  provider: string;
  isAdmin: boolean;
  sessionCount: number;
  createdAt: string;
}

export interface AdminSessionListItem {
  id: number;
  startedAt: string;
  endedAt: string | null;
  user: { id: number; email: string; displayName: string | null } | null;
  character: { id: number; displayName: string; slug: string };
  messageCount: number;
  noteCount: number;
  hasFeedback: boolean;
}

export interface AdminSessionMessage {
  id: number;
  role: string;
  content: string;
  createdAt: string;
}

export interface AdminSessionDetail {
  id: number;
  startedAt: string;
  endedAt: string | null;
  feedback: string | null;
  feedbackJson: string | null;
  patientMemory: string | null;
  user: { id: number; email: string; displayName: string | null } | null;
  character: { id: number; displayName: string; slug: string };
  messages: AdminSessionMessage[];
  notes: Note[];
  assessment: AssessmentJson | null;
  errors: AdminErrorLog[];
}

export interface AdminErrorLog {
  id: number;
  userId: number | null;
  sessionId: number | null;
  endpoint: string;
  method: string;
  status: number;
  message: string;
  stack: string | null;
  createdAt: string;
  user?: { id: number; email: string; displayName: string | null } | null;
}

function parseSseFrame(frame: string): { type: string; data: unknown } | null {
  let evType = 'message';
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      evType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch {
    data = dataStr;
  }
  return { type: evType, data };
}

/** Billing types — mirror backend's PlanConfig in plans.config.ts. */
export interface PlanFeatures {
  psychTests: boolean;
  progressGraphs: boolean;
  pdfExport: boolean;
  customCharacters: boolean;
  advancedAnalytics: boolean;
  notionExport: boolean;
  earlyAccess: boolean;
  prioritySupport: boolean;
}

export interface PlanConfig {
  id: 'trial' | 'lite' | 'pro' | 'master';
  name: string;
  tagline: string;
  priceUah: number;
  priceUsd: number;
  annualPriceUah: number | null;
  semesterPriceUah: number | null;
  trialDays: number | null;
  sessionLimit: number | null;
  softCap: number | null;
  reviewerModel: 'sonnet' | 'opus';
  charactersAccessibleCount: number | null;
  modalitiesAllAccess: boolean;
  features: PlanFeatures;
  highlights: string[];
}

export interface BillingStatus {
  plan: 'trial' | 'lite' | 'pro' | 'master';
  config: PlanConfig;
  status: 'active' | 'paused' | 'canceled' | 'expired';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  canceledAt: string | null;
  pausedAt: string | null;
  resumesAt: string | null;
  sessionsUsed: number;
  sessionsRemaining: number | null;
  sessionLimit: number | null;
  softCap: number | null;
  daysUntilPeriodEnd: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private base = '/api';

  // ---------------------------------------------------------------
  // Billing
  // ---------------------------------------------------------------

  listPlans(): Promise<PlanConfig[]> {
    return firstValueFrom(this.http.get<PlanConfig[]>(`${this.base}/billing/plans`));
  }

  billingStatus(): Promise<BillingStatus> {
    return firstValueFrom(this.http.get<BillingStatus>(`${this.base}/billing/me`));
  }

  cancelSubscription(): Promise<unknown> {
    return firstValueFrom(this.http.post(`${this.base}/billing/cancel`, {}));
  }

  pauseSubscription(resumeInDays?: number): Promise<unknown> {
    return firstValueFrom(
      this.http.post(`${this.base}/billing/pause`, { resumeInDays }),
    );
  }

  resumeSubscription(): Promise<unknown> {
    return firstValueFrom(this.http.post(`${this.base}/billing/resume`, {}));
  }

  // ---------------------------------------------------------------
  // Characters
  // ---------------------------------------------------------------

  listCharacters(): Promise<Character[]> {
    return firstValueFrom(this.http.get<Character[]>(`${this.base}/characters`));
  }

  /**
   * Fetches the static modality catalog from the backend. The list is
   * the single source of truth (label, icon, description) — fetched
   * once at app boot or on patient-form open. Static so it's cheap to
   * cache on the frontend side; backend just returns the constant.
   */
  listModalities(): Promise<ModalityInfo[]> {
    return firstValueFrom(
      this.http.get<ModalityInfo[]>(`${this.base}/characters/modalities`),
    );
  }

  patientCard(characterId: number): Promise<PatientCard> {
    return firstValueFrom(
      this.http.get<PatientCard>(`${this.base}/characters/${characterId}/full`),
    );
  }

  /**
   * Patient creation pipeline:
   *  1. Form collects brief → draftCharacter() returns generated markdown
   *  2. User edits/reviews → createCharacter() persists
   *  3. (later) updateCharacter() / deleteCharacter() for edits
   */
  draftCharacter(brief: CharacterDraftBrief): Promise<{ markdown: string }> {
    return firstValueFrom(
      this.http.post<{ markdown: string }>(`${this.base}/characters/draft`, brief),
    );
  }

  /**
   * Per-field LLM assist. Powers the ✨ buttons next to each input on
   * the patient-form. Returns one value coerced server-side to the
   * right shape for the field (number for age/difficulty/complexity,
   * string[] for themes, plain string for the rest).
   */
  draftField(
    field: DraftFieldName,
    brief: Partial<CharacterDraftBrief>,
  ): Promise<DraftFieldResult> {
    return firstValueFrom(
      this.http.post<DraftFieldResult>(`${this.base}/characters/draft-field`, {
        field,
        brief,
      }),
    );
  }

  createCharacter(dto: CreateCharacterDto): Promise<Character> {
    return firstValueFrom(
      this.http.post<Character>(`${this.base}/characters`, dto),
    );
  }

  updateCharacter(
    id: number,
    dto: Partial<CreateCharacterDto>,
  ): Promise<Character> {
    return firstValueFrom(
      this.http.patch<Character>(`${this.base}/characters/${id}`, dto),
    );
  }

  deleteCharacter(id: number): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${this.base}/characters/${id}`));
  }

  /**
   * Sharing — owner-only. Used on patient-detail "👥 Доступ" modal:
   *  listShares → render current colleagues
   *  addShare(email) → grant read-access to a registered user
   *  removeShare(id) → revoke a specific grant
   */
  listShares(characterId: number): Promise<CharacterShare[]> {
    return firstValueFrom(
      this.http.get<CharacterShare[]>(`${this.base}/characters/${characterId}/shares`),
    );
  }

  addShare(characterId: number, email: string): Promise<CharacterShare> {
    return firstValueFrom(
      this.http.post<CharacterShare>(`${this.base}/characters/${characterId}/shares`, { email }),
    );
  }

  removeShare(characterId: number, shareId: number): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`${this.base}/characters/${characterId}/shares/${shareId}`),
    );
  }

  startSession(characterId: number): Promise<StartSessionResponse> {
    return firstValueFrom(
      this.http.post<StartSessionResponse>(`${this.base}/sessions`, { characterId }),
    );
  }

  sendMessage(sessionId: number, content: string): Promise<SendMessageResponse> {
    return firstValueFrom(
      this.http.post<SendMessageResponse>(
        `${this.base}/sessions/${sessionId}/messages`,
        { content },
      ),
    );
  }

  /**
   * Coach-mode hint — student asks "what should I say next". Returns 3
   * strategic suggestions; empty array if backend returned nothing.
   */
  requestHint(sessionId: number): Promise<HintResult> {
    return firstValueFrom(
      this.http.post<HintResult>(`${this.base}/sessions/${sessionId}/hint`, {}),
    );
  }

  // ─── Psychological tests catalog ─────────────────────────────────────────

  listPsychTests(opts: { q?: string; domain?: string } = {}): Promise<PsychTestSummary[]> {
    const params: Record<string, string> = {};
    if (opts.q) params['q'] = opts.q;
    if (opts.domain) params['domain'] = opts.domain;
    return firstValueFrom(
      this.http.get<PsychTestSummary[]>(`${this.base}/tests`, { params }),
    );
  }

  listTestDomains(): Promise<string[]> {
    return firstValueFrom(this.http.get<string[]>(`${this.base}/tests/domains`));
  }

  getPsychTest(key: string): Promise<PsychTest> {
    return firstValueFrom(this.http.get<PsychTest>(`${this.base}/tests/${key}`));
  }

  administerTest(sessionId: number, testKey: string): Promise<SessionTest> {
    return firstValueFrom(
      this.http.post<SessionTest>(`${this.base}/sessions/${sessionId}/tests`, { testKey }),
    );
  }

  listSessionTests(sessionId: number): Promise<SessionTest[]> {
    return firstValueFrom(
      this.http.get<SessionTest[]>(`${this.base}/sessions/${sessionId}/tests`),
    );
  }

  endSession(sessionId: number): Promise<EndSessionResponse> {
    return firstValueFrom(
      this.http.post<EndSessionResponse>(`${this.base}/sessions/${sessionId}/end`, {}),
    );
  }

  /**
   * Hard-delete a session — backend cascades to messages + notes. After
   * this, the session is "як така що не розпочиналась" — gone from sessions
   * tab, doesn't count, doesn't affect patient memory or trends.
   */
  discardSession(sessionId: number): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`${this.base}/sessions/${sessionId}`),
    );
  }

  /**
   * Read-only fetch of a session for the /session/:id/view page. Backend
   * allows either the owner or any admin/supervisor.
   */
  viewSession(sessionId: number): Promise<SessionView> {
    return firstValueFrom(
      this.http.get<SessionView>(`${this.base}/sessions/${sessionId}`),
    );
  }

  /**
   * Streaming variant of endSession. Yields SSE events as they arrive from the
   * backend. The HttpInterceptor doesn't run here — we use raw fetch — so we
   * attach the access token manually and bounce on 401 (no auto-refresh).
   * For MVP that's fine; ending a session is a single explicit action.
   */
  async *endSessionStream(
    sessionId: number,
    signal?: AbortSignal,
  ): AsyncGenerator<FeedbackStreamEvent, void, unknown> {
    const token = this.auth.accessToken();
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${this.base}/sessions/${sessionId}/end-stream`, {
      method: 'POST',
      headers,
      signal,
    });

    if (response.status === 401) {
      this.auth.forceLogout();
      throw new Error('Сесія авторизації прострочена. Увійди знов.');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text || 'не вдалося стартувати стрім'}`);
    }
    if (!response.body) {
      throw new Error('Браузер не підтримує streaming response.');
    }

    yield* this.parseSseStream(response.body);
  }

  private async *parseSseStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<FeedbackStreamEvent, void, unknown> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush trailing buffer if it happens to be a complete frame.
          if (buffer.trim()) {
            const ev = parseSseFrame(buffer);
            if (ev) yield ev as FeedbackStreamEvent;
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseSseFrame(frame);
          if (ev) yield ev as FeedbackStreamEvent;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  listNotes(sessionId: number): Promise<Note[]> {
    return firstValueFrom(
      this.http.get<Note[]>(`${this.base}/sessions/${sessionId}/notes`),
    );
  }

  createNote(sessionId: number, input: CreateNoteInput): Promise<Note> {
    return firstValueFrom(
      this.http.post<Note>(`${this.base}/sessions/${sessionId}/notes`, input),
    );
  }

  deleteNote(sessionId: number, noteId: number): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`${this.base}/sessions/${sessionId}/notes/${noteId}`),
    );
  }

  // ─── Profile ────────────────────────────────────────────────────────────

  /**
   * PATCH the user's identity fields. Backend returns the fresh user
   * shape — caller should push into AuthService so the header etc. see
   * the new displayName immediately.
   */
  updateProfile(patch: { displayName?: string; bio?: string }): Promise<AuthUser> {
    return firstValueFrom(this.http.patch<AuthUser>(`${this.base}/auth/me`, patch));
  }

  /**
   * Change password. Returns AuthResult with fresh tokens (refresh hash
   * rotated on backend). Caller must call AuthService.applyAuthResult so
   * cached tokens stay valid; otherwise next request 401's.
   */
  changePassword(currentPassword: string, newPassword: string): Promise<AuthResult> {
    return firstValueFrom(
      this.http.post<AuthResult>(`${this.base}/auth/me/password`, {
        currentPassword,
        newPassword,
      }),
    );
  }

  // ─── Admin ──────────────────────────────────────────────────────────────

  adminListUsers(): Promise<AdminUser[]> {
    return firstValueFrom(this.http.get<AdminUser[]>(`${this.base}/admin/users`));
  }

  adminListSessions(filter?: {
    userId?: number;
    ended?: boolean;
  }): Promise<AdminSessionListItem[]> {
    let params: Record<string, string> = {};
    if (filter?.userId != null) params['userId'] = String(filter.userId);
    if (filter?.ended != null) params['ended'] = String(filter.ended);
    return firstValueFrom(
      this.http.get<AdminSessionListItem[]>(`${this.base}/admin/sessions`, { params }),
    );
  }

  adminGetSession(id: number): Promise<AdminSessionDetail> {
    return firstValueFrom(this.http.get<AdminSessionDetail>(`${this.base}/admin/sessions/${id}`));
  }

  adminDeleteSession(id: number): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${this.base}/admin/sessions/${id}`));
  }

  adminListErrors(opts?: { limit?: number; userId?: number }): Promise<AdminErrorLog[]> {
    const params: Record<string, string> = {};
    if (opts?.limit != null) params['limit'] = String(opts.limit);
    if (opts?.userId != null) params['userId'] = String(opts.userId);
    return firstValueFrom(
      this.http.get<AdminErrorLog[]>(`${this.base}/admin/errors`, { params }),
    );
  }

  /** Acquisition funnel for the past 7 days. */
  adminFunnel(): Promise<AdminFunnel> {
    return firstValueFrom(
      this.http.get<AdminFunnel>(`${this.base}/admin/analytics/funnel`),
    );
  }

  /** Most-recent N telemetry events. */
  adminRecentEvents(limit = 100): Promise<AdminEvent[]> {
    return firstValueFrom(
      this.http.get<AdminEvent[]>(
        `${this.base}/admin/analytics/recent`,
        { params: { limit: String(limit) } },
      ),
    );
  }
}

export interface AdminFunnel {
  windowDays: number;
  since: string;
  funnel: {
    visited_demo_or_pricing: number;
    registered: number;
    started_first_session: number;
    started_third_session: number;
    viewed_feedback: number;
  };
  rates: {
    register_per_visit: number | null;
    session_per_register: number | null;
    feedback_per_session: number | null;
    retention_3plus_sessions: number | null;
  };
}

export interface AdminEvent {
  id: number;
  eventType: string;
  userId: number | null;
  anonHash: string | null;
  props: string | null;
  createdAt: string;
}
