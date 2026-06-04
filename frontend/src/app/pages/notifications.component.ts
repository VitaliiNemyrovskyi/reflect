import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, type AppNotification } from '../api.service';
import { I18nService } from '../i18n.service';
import { IconComponent } from '../icon.component';

/**
 * Notification centre — the full feed behind the header bell. Lists every
 * notification the user has received (newest first), shows read/unread state,
 * lets them mark one (by opening it) or all read, and deep-links to the
 * relevant page on click. The global app-header (with the bell) renders above
 * this via app.component, so the page itself is content-only.
 */
@Component({
  selector: 'app-notifications-page',
  standalone: true,
  imports: [CommonModule, IconComponent],
  template: `
    <main class="wrap">
      <section class="panel panel-soft frame-bordered">
        <div class="head">
          <span class="section-label">
            <app-icon name="bell" /> {{ i18n.isEn ? 'Notifications' : 'Сповіщення' }}
          </span>
          @if (items().length) {
            <button type="button" class="ghost small" (click)="markAll()">
              {{ i18n.isEn ? 'Mark all read' : 'Прочитати всі' }}
            </button>
          }
        </div>

        @if (loading()) {
          <p class="hint">{{ i18n.isEn ? 'Loading…' : 'Завантаження…' }}</p>
        } @else if (items().length === 0) {
          <div class="empty">
            <app-icon name="bell" />
            <p>{{ i18n.isEn ? 'No notifications yet.' : 'Сповіщень ще немає.' }}</p>
            <span class="empty-sub">
              {{ i18n.isEn
                ? 'Feedback, badges and reminders will show up here.'
                : 'Тут зʼявлятимуться фідбек, бейджі та нагадування.' }}
            </span>
          </div>
        } @else {
          <ul class="nlist">
            @for (n of items(); track n.id) {
              <li class="nrow" [class.unread]="!n.read" [class.clickable]="!!n.url" (click)="open(n)">
                <app-icon [name]="iconFor(n.type)" class="nicon" />
                <div class="ntext">
                  <p class="nbody">{{ n.body }}</p>
                  <span class="ntime">{{ fmt(n.createdAt) }}</span>
                </div>
                @if (!n.read) { <span class="ndot" aria-hidden="true"></span> }
              </li>
            }
          </ul>
        }
      </section>
    </main>
  `,
  styles: [`
    :host { display: block; }
    .wrap { max-width: 680px; margin: 0 auto; }
    .head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 14px; gap: 12px;
    }
    .section-label { display: flex; align-items: center; gap: 7px; }
    .section-label app-icon { font-size: 16px; color: var(--accent); }
    .hint { color: var(--fg-dim); font-size: 14px; }

    .empty { text-align: center; padding: 40px 16px; color: var(--fg-dim); }
    .empty app-icon { font-size: 30px; color: color-mix(in srgb, var(--accent) 50%, var(--fg-dim)); }
    .empty p { margin: 12px 0 4px; font-size: 15px; color: var(--fg); }
    .empty-sub { font-size: 13px; }

    .nlist { list-style: none; margin: 0; padding: 0; }
    .nrow {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 14px 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      border-radius: 8px;
      transition: background .12s ease;
    }
    .nrow:last-child { border-bottom: none; }
    .nrow.clickable { cursor: pointer; }
    .nrow.clickable:hover { background: rgba(255, 255, 255, 0.03); }
    .nrow.unread { background: color-mix(in srgb, var(--accent) 6%, transparent); }
    .nicon { font-size: 18px; color: var(--accent); margin-top: 1px; flex: 0 0 auto; }
    .ntext { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
    .nbody { margin: 0; font-size: 14px; line-height: 1.5; color: var(--fg); }
    .ntime { font-size: 12px; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
    .ndot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent); flex: 0 0 auto; margin-top: 6px;
    }
  `],
})
export class NotificationsComponent implements OnInit {
  protected i18n = inject(I18nService);
  private api = inject(ApiService);
  private router = inject(Router);

  protected items = signal<AppNotification[]>([]);
  protected loading = signal(true);

  async ngOnInit(): Promise<void> {
    try {
      this.items.set(await this.api.getNotifications(100));
    } catch {
      /* leave empty */
    } finally {
      this.loading.set(false);
    }
  }

  async open(n: AppNotification): Promise<void> {
    if (!n.read) {
      this.items.update((l) => l.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      void this.api.markNotificationRead(n.id).catch(() => undefined);
    }
    if (n.url) void this.router.navigateByUrl(n.url);
  }

  async markAll(): Promise<void> {
    this.items.update((l) => l.map((x) => ({ ...x, read: true })));
    try {
      await this.api.markAllNotificationsRead();
    } catch {
      /* noop */
    }
  }

  protected iconFor(type: string): string {
    switch (type) {
      case 'feedback': return 'message';
      case 'badge': return 'trophy';
      case 'reminder': return 'heart-handshake';
      case 'announcement': return 'bell';
      default: return 'bell';
    }
  }

  protected fmt(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(this.i18n.isEn ? 'en-GB' : 'uk-UA', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
