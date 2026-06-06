import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../api.service';
import { I18nService } from '../i18n.service';
import { SessionStateService } from '../session-state.service';
import { AnalyticsService } from '../analytics.service';

@Component({
  selector: 'app-intro',
  standalone: true,
  template: `
    <section class="intro-panel synapse-panel">
      <span class="section-label">{{ i18n.t('session_intro.label') }}</span>
      <h2 class="display-name">{{ displayName() ?? i18n.t('session_intro.client_fallback') }}</h2>

      <div class="intro-text">
        <p>{{ i18n.t('session_intro.about') }}</p>
        <p>{{ i18n.t('session_intro.duration') }}</p>
        <p>{{ i18n.t('session_intro.privacy') }}</p>
      </div>

      <div class="actions">
        <button class="primary" [disabled]="starting()" (click)="start()">
          {{ starting() ? enteringText() : i18n.t('chars.start') }}
        </button>
        <button class="ghost" (click)="back()">{{ i18n.t('general.back') }}</button>
      </div>

      @if (error()) {
        <p class="hint danger">{{ error() }}</p>
      }
    </section>
  `,
  styles: [`
    .intro-panel {
      padding: 32px;
      margin-top: 24px;
    }
    .display-name {
      font-size: 28px;
      margin: 6px 0 0;
      font-weight: 400;
      letter-spacing: -0.01em;
    }
    .intro-text { margin: 28px 0; }
    .intro-text p { color: var(--fg-dim); }
    .intro-text p:first-child { color: var(--fg); }
    .actions { display: flex; gap: 10px; }
    .hint { font-size: 13px; margin-top: 18px; }
    .hint.danger { color: var(--danger); }
  `],
})
export class IntroComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private state = inject(SessionStateService);
  private analytics = inject(AnalyticsService);
  readonly i18n = inject(I18nService);

  displayName = signal<string | null>(null);
  starting = signal(false);
  error = signal<string | null>(null);
  private characterId = 0;

  /** Loading-state button text — substitutes the patient's displayName
   *  into the localized "{name} entering the room…" template. Uses the
   *  client-fallback label when displayName hasn't resolved yet (deep
   *  link, history.state empty, API still in-flight). */
  enteringText = computed(() => {
    const name = this.displayName() ?? this.i18n.t('session_intro.client_fallback');
    return this.i18n.t('session_intro.entering', { name });
  });

  async ngOnInit() {
    this.characterId = Number(
      this.route.snapshot.paramMap.get('id') ??
        this.route.snapshot.paramMap.get('characterId'),
    );
    const fromState = (history.state as { displayName?: string } | undefined)?.displayName;
    if (fromState) {
      this.displayName.set(fromState);
    } else if (this.characterId) {
      // Fetch from API if not in history (e.g., coming via deep link)
      try {
        const card = await this.api.patientCard(this.characterId);
        this.displayName.set(card.displayName);
      } catch {
        // ignore — user just sees default
      }
    }
  }

  async start() {
    this.starting.set(true);
    this.error.set(null);
    try {
      const data = await this.api.startSession(this.characterId);
      this.state.reset(data.character.displayName, null, data.character.avatarUrl ?? null, this.characterId);
      this.state.push({ role: 'assistant', content: data.firstMessage });
      // Tag the cached bubbles with their session so chat.component trusts
      // them (and doesn't refetch) — and so a later session can't show these.
      this.state.sessionId.set(Number(data.sessionId));
      this.analytics.track('session.created', { characterId: this.characterId }, data.sessionId);
      void this.router.navigate(['/session', data.sessionId]);
    } catch (e: unknown) {
      this.error.set(this.errMsg(e));
    } finally {
      this.starting.set(false);
    }
  }

  back() {
    if (this.characterId) {
      void this.router.navigate(['/patient', this.characterId]);
    } else {
      void this.router.navigate(['/']);
    }
  }

  private errMsg(e: unknown): string {
    const body = (e as { error?: { message?: string; error?: string } })?.error;
    return body?.message ?? body?.error ?? 'Не вдалося почати сесію.';
  }
}
