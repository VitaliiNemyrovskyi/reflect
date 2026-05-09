import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Character {
  id: number;
  slug: string;
  displayName: string;
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

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = '/api';

  listCharacters(): Promise<Character[]> {
    return firstValueFrom(this.http.get<Character[]>(`${this.base}/characters`));
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

  endSession(sessionId: number): Promise<EndSessionResponse> {
    return firstValueFrom(
      this.http.post<EndSessionResponse>(`${this.base}/sessions/${sessionId}/end`, {}),
    );
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
}
