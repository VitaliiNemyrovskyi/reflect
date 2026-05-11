import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService, type AuthResult, type AuthUser } from './auth.service';

export type ProgressBadge = 'improving' | 'stable' | 'worsening' | 'unknown';

export interface Character {
  id: number;
  slug: string;
  displayName: string;
  diagnosis?: string | null;     // Ukrainian-language label, shown directly on UI
  diagnosisCode?: string | null; // English DSM-5 / ICD code, shown as tooltip
  difficulty?: number | null;    // behavioral (Поведінка) — modulates LLM
  complexity?: number | null;    // clinical (Тяжкість) — informational
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
  brief?: string;
  hiddenLayerHint?: string;
  voiceNotes?: string;
  themes?: string[];
}

export interface CreateCharacterDto {
  displayName: string;
  profileText: string;
  diagnosis?: string;
  diagnosisCode?: string;
  difficulty?: number;
  complexity?: number;
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
  assessment: AssessmentJson | null;
}

export type FeedbackStreamEvent =
  | { type: 'cached'; data: { feedback: string } }
  | { type: 'chunk'; data: { text: string } }
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

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private base = '/api';

  listCharacters(): Promise<Character[]> {
    return firstValueFrom(this.http.get<Character[]>(`${this.base}/characters`));
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
}
