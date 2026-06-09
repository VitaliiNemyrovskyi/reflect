import { CommonModule, DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ApiService,
  type CohortList,
  type CohortDetail,
  type OwnedCohort,
  type JoinedCohort,
  type CohortStudentRow,
  type StudentSessionRow,
  type StudentSessionDetail,
} from '../api.service';
import { AuthService } from '../auth.service';
import { I18nService } from '../i18n.service';
import { IconComponent } from '../icon.component';

/**
 * /cohorts — teaching cohort mode (B2B / instructor).
 *
 * Two audiences on one page, gated by role:
 *   • Instructor (admin-granted isInstructor) — creates groups, shares the
 *     6-char invite code, and opens a group to see every member's progress
 *     in a board-style table (reuses the §14 therapist-board shape, but
 *     scoped to that one group and including students who haven't started).
 *   • Student (anyone) — joins a group by code and sees the groups they're
 *     a member of (with the instructor's name).
 *
 * Everything reads from /api/cohorts. Mutations: POST /cohorts (create),
 * POST /cohorts/join. The per-group detail (GET /cohorts/:id) is loaded
 * lazily when an instructor opens a group, so the list view stays light.
 *
 * Principle #2 (no competitive ranking): the member table is sorted by
 * name, framed as private oversight — never a leaderboard.
 */
@Component({
  selector: 'app-cohorts',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent],
  template: `
    <div class="cohorts-page fx-fade-up">
      <header class="page-head">
        <a routerLink="/" class="back">← {{ i18n.t('cohorts.backHome') }}</a>
        <h1>{{ i18n.t('cohorts.title') }}</h1>
        <p class="sub">
          {{ i18n.t('cohorts.subtitle') }}
        </p>
      </header>

      @if (loading()) {
        <div class="panel skel">
          <div class="fx-shimmer skel-line w40"></div>
          <div class="fx-shimmer skel-line w70"></div>
        </div>
      } @else if (error()) {
        <div class="panel callout panel-soft">
          <p class="err">{{ error() }}</p>
          <button class="ghost small" (click)="reload()">{{ i18n.t('cohorts.retry') }}</button>
        </div>
      } @else {
       @if (data(); as d) {

        <!-- ── Instructor: create + owned groups ─────────────────────── -->
        @if (isInstructor()) {
          <section class="panel panel-soft frame-bordered block">
            <span class="section-label"><app-icon name="flag" /> {{ i18n.t('cohorts.instructor') }}</span>

            <form class="create-row" (submit)="create($event)">
              <input
                type="text"
                class="text-input"
                [ngModel]="newName()"
                (ngModelChange)="newName.set($event)"
                name="cohortName"
                maxlength="80"
                [placeholder]="i18n.t('cohorts.newGroupPlaceholder')" />
              <button type="submit" class="primary small" [disabled]="creating() || !newName().trim()">
                {{ creating() ? '…' : i18n.t('cohorts.create') }}
              </button>
            </form>

            @if (d.owned.length === 0) {
              <p class="empty-hint">{{ i18n.t('cohorts.noGroupsYet') }}</p>
            } @else {
              <ul class="cohort-list">
                @for (c of d.owned; track c.id) {
                  <li class="cohort-card" [class.open]="selectedId() === c.id">
                    <div class="cohort-main">
                      <div class="cohort-id">
                        <span class="cohort-name">{{ c.name }}</span>
                        <span class="member-count">
                          <app-icon name="users" />{{ c.memberCount ?? 0 }}
                        </span>
                      </div>
                      <div class="cohort-tools">
                        <button class="code-chip" (click)="copyCode(c.inviteCode)"
                                [title]="i18n.t('cohorts.copyInviteCode')">
                          <app-icon name="link" />
                          <code>{{ c.inviteCode }}</code>
                          @if (copiedCode() === c.inviteCode) { <span class="copied">✓</span> }
                        </button>
                        <button class="link-btn" (click)="copyLink(c.inviteCode)"
                                [title]="i18n.t('cohorts.copyInviteLink')">
                          {{ copiedLink() === c.inviteCode ? i18n.t('cohorts.copiedLink') : i18n.t('cohorts.link') }}
                        </button>
                        <button class="link-btn" (click)="toggleDetail(c)">
                          {{ selectedId() === c.id ? i18n.t('cohorts.collapse') : i18n.t('cohorts.studentsArrow') }}
                        </button>
                        <button class="link-btn danger" [disabled]="deletingId() === c.id" (click)="deleteCohort(c)">
                          {{ deletingId() === c.id ? '…' : i18n.t('cohorts.delete') }}
                        </button>
                      </div>
                    </div>

                    @if (selectedId() === c.id) {
                      @if (detailLoading()) {
                        <div class="fx-shimmer skel-line w70" style="margin-top:12px"></div>
                      } @else {
                       @if (detail(); as det) {
                        <div class="students">
                          @if (det.students.length === 0) {
                            <p class="empty-hint">{{ i18n.t('cohorts.noOneJoined') }}</p>
                          } @else {
                            <table class="data-table board-table">
                              <thead>
                                <tr>
                                  <th>{{ i18n.t('cohorts.colStudent') }}</th>
                                  <th>{{ i18n.t('cohorts.colStage') }}</th>
                                  <th class="num">{{ i18n.t('cohorts.colCompetency') }}</th>
                                  <th class="num">{{ i18n.t('cohorts.colSessions') }}</th>
                                  <th class="num">{{ i18n.t('cohorts.colBadges') }}</th>
                                  <th class="num">{{ i18n.t('cohorts.colPatients') }}</th>
                                  <th class="num">{{ i18n.t('cohorts.colActive') }}</th>
                                  <th></th>
                                </tr>
                              </thead>
                              <tbody>
                                @for (s of det.students; track s.userId) {
                                  <tr [class.inactive]="s.sessionsCompleted === 0">
                                    <td>
                                      <span class="s-name">{{ s.displayName || s.email }}</span>
                                      @if (s.displayName) { <div class="s-email dim">{{ s.email }}</div> }
                                    </td>
                                    <td><span class="stage-chip">{{ s.stage }}</span></td>
                                    <td class="num"><span class="comp-val">{{ s.meanCompetency }}</span><span class="dim">/100</span></td>
                                    <td class="num">{{ s.sessionsCompleted }}</td>
                                    <td class="num">{{ s.badgeCount }}<span class="dim">/{{ s.awardableCount }}</span></td>
                                    <td class="num">
                                      {{ s.patients }}
                                      @if (s.lapsed > 0) {
                                        <span class="lapsed-tag" [title]="i18n.t('cohorts.lapsedTitle')">
                                          <span class="lapsed-dot"></span>{{ s.lapsed }}
                                        </span>
                                      }
                                    </td>
                                    <td class="num dim">{{ s.lastActiveAt ? (s.lastActiveAt | date: 'dd.MM.yy') : '—' }}</td>
                                    <td class="num actions-cell">
                                      @if (s.sharing) {
                                        <button class="link-btn" (click)="openStudent(det, s)">{{ i18n.t('cohorts.sessionsArrow') }}</button>
                                      } @else {
                                        <span class="dim no-access" [title]="i18n.t('cohorts.noSessionAccess')">
                                          <app-icon name="lock" />
                                        </span>
                                      }
                                      <button class="link-btn danger" [disabled]="memberBusy() === s.userId" (click)="removeStudent(det, s)">
                                        {{ memberBusy() === s.userId ? '…' : i18n.t('cohorts.remove') }}
                                      </button>
                                    </td>
                                  </tr>
                                }
                              </tbody>
                            </table>
                          }
                        </div>
                       }
                      }
                    }
                  </li>
                }
              </ul>
            }
          </section>
        }

        <!-- ── Student: join + joined groups ─────────────────────────── -->
        <section class="panel panel-soft frame-bordered block">
          <span class="section-label"><app-icon name="users" /> {{ i18n.t('cohorts.myGroups') }}</span>

          @if (viaInvite()) {
            <p class="invite-note">
              <app-icon name="link" />
              {{ i18n.t('cohorts.inviteNote') }}
            </p>
          }

          <form class="create-row" (submit)="join($event)">
            <input
              type="text"
              class="text-input code-input"
              [ngModel]="joinCode()"
              (ngModelChange)="joinCode.set($event.toUpperCase())"
              name="joinCode"
              maxlength="6"
              autocapitalize="characters"
              [placeholder]="i18n.t('cohorts.inviteCodePlaceholder')" />
            <button type="submit" class="primary small" [disabled]="joining() || joinCode().trim().length < 4">
              {{ joining() ? '…' : i18n.t('cohorts.join') }}
            </button>
          </form>

          @if (d.joined.length === 0) {
            <p class="empty-hint">{{ i18n.t('cohorts.notInAnyGroup') }}</p>
          } @else {
            <ul class="cohort-list">
              @for (c of d.joined; track c.id) {
                <li class="cohort-card joined">
                  <div class="cohort-main">
                    <div class="cohort-id">
                      <span class="cohort-name">{{ c.name }}</span>
                    </div>
                    <div class="joined-right">
                      <span class="instructor-tag">
                        <app-icon name="flag" />{{ c.instructor }}
                      </span>
                      <button class="link-btn danger" [disabled]="leaveBusy() === c.id" (click)="leave(c)">
                        {{ leaveBusy() === c.id ? '…' : i18n.t('cohorts.leave') }}
                      </button>
                    </div>
                  </div>
                  <label class="consent-toggle">
                    <input type="checkbox" [checked]="c.shareSessions"
                           [disabled]="consentBusy() === c.id" (change)="setConsent(c, $event)" />
                    <span>{{ i18n.t('cohorts.consentToggle') }}</span>
                  </label>
                </li>
              }
            </ul>

            <p class="consent-note">
              <app-icon name="shield-check" />
              {{ i18n.t('cohorts.consentNote') }}
            </p>
          }
        </section>

        <!-- ── Instructor drilldown: one consenting student's sessions ── -->
        @if (drillStudent(); as ds) {
          <div class="modal-backdrop" (click)="closeStudent()"></div>
          <div class="drill-modal fx-fade-up" role="dialog" aria-modal="true">
            <div class="drill-head">
              <div class="drill-head-left">
                @if (drillDetail() || drillDetailLoading()) {
                  <button class="link-btn" (click)="backToList()">← {{ i18n.t('cohorts.backToList') }}</button>
                }
                <span class="drill-title">{{ ds.row.displayName || ds.row.email }}</span>
              </div>
              <button class="x-btn" (click)="closeStudent()" [attr.aria-label]="i18n.t('cohorts.close')">✕</button>
            </div>

            @if (drillDetailLoading()) {
              <div class="fx-shimmer skel-line w70" style="margin:14px"></div>
            } @else {
              @if (drillDetail(); as sd) {
                <div class="drill-body">
                  <div class="sd-meta">
                    <strong>{{ sd.character }}</strong>
                    <span class="dim">{{ sd.startedAt | date: 'dd.MM.yy HH:mm' }}</span>
                  </div>
                  @if (sd.feedback) {
                    <div class="sd-block">
                      <span class="section-label">{{ i18n.t('cohorts.supervisorFeedback') }}</span>
                      <pre class="fb-text">{{ sd.feedback }}</pre>
                    </div>
                  }
                  <div class="sd-block">
                    <span class="section-label">{{ i18n.t('cohorts.transcript') }}</span>
                    <div class="transcript">
                      @for (m of sd.messages; track $index) {
                        <div class="msg" [class.mine]="m.role === 'user'">
                          <span class="msg-role">{{ roleLabel(m.role) }}</span>
                          <div class="msg-bubble">{{ m.content }}</div>
                        </div>
                      }
                    </div>
                  </div>
                </div>
              } @else {
                <div class="drill-body">
                  @if (drillLoading()) {
                    <div class="fx-shimmer skel-line w70"></div>
                  } @else {
                    @if (drillSessions(); as rows) {
                    @if (rows.length === 0) {
                      <p class="empty-hint">{{ i18n.t('cohorts.noCompletedSessions') }}</p>
                    } @else {
                      <ul class="sess-list">
                        @for (r of rows; track r.id) {
                          <li>
                            <button class="sess-row" (click)="openSession(r.id)">
                              <span class="sess-char">{{ r.character }}</span>
                              <span class="dim">{{ r.startedAt | date: 'dd.MM.yy' }}</span>
                              <span class="dim sess-msgs">{{ r.messageCount }} {{ i18n.t('cohorts.msgs') }}</span>
                              @if (!r.hasFeedback) { <span class="dim">· {{ i18n.t('cohorts.noFeedback') }}</span> }
                              <span class="sess-go">→</span>
                            </button>
                          </li>
                        }
                      </ul>
                    }
                    }
                  }
                </div>
              }
            }
          </div>
        }

        @if (!isInstructor()) {
          <p class="footnote">
            {{ i18n.t('cohorts.instructorAccessFootnote') }}
          </p>
        }
       }
      }
    </div>
  `,
  styles: [`
    .cohorts-page { max-width: 860px; margin: 0 auto; }
    .page-head { margin-bottom: 20px; }
    .page-head .back {
      display: inline-block; color: var(--fg-dim); text-decoration: none;
      font-size: 13px; margin-bottom: 8px;
    }
    .page-head .back:hover { color: var(--accent); }
    .page-head h1 { margin: 0 0 4px; font-size: 26px; }
    .page-head .sub { margin: 0; color: var(--fg-dim); font-size: 14px; }

    .block { margin-bottom: 20px; }
    .section-label { display: inline-flex; align-items: center; gap: 7px; }
    .section-label app-icon { font-size: 15px; color: var(--accent); }

    .create-row { display: flex; gap: 8px; margin: 14px 0 4px; flex-wrap: wrap; }
    .text-input {
      flex: 1 1 220px; min-width: 0;
      padding: 9px 12px; font-size: 14px;
      background: var(--user-bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 8px;
    }
    .text-input:focus { outline: none; border-color: var(--accent); }
    .code-input {
      flex: 0 1 180px; letter-spacing: .18em; text-transform: uppercase;
      font-variant-numeric: tabular-nums; font-weight: 600;
    }

    .empty-hint { color: var(--fg-dim); font-size: 13px; margin: 12px 0 2px; }
    .footnote {
      color: var(--fg-dim); font-size: 12.5px; text-align: center;
      margin: 4px 0 0; line-height: 1.5;
    }

    .cohort-list { list-style: none; padding: 0; margin: 14px 0 0; display: flex; flex-direction: column; gap: 10px; }
    .cohort-card {
      padding: 12px 14px; border-radius: 10px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--accent) 3%, transparent);
      transition: border-color .15s ease;
    }
    .cohort-card.open { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
    .cohort-main { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .cohort-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .cohort-name { font-weight: 500; font-size: 15px; }
    .member-count {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 12px; color: var(--fg-dim);
    }
    .member-count app-icon { font-size: 13px; }

    .cohort-tools { display: flex; align-items: center; gap: 12px; }
    .code-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 999px; cursor: pointer;
      background: var(--user-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
      color: var(--fg); font-size: 12px;
      transition: border-color .15s ease;
    }
    .code-chip:hover { border-color: var(--accent); }
    .code-chip app-icon { font-size: 13px; color: var(--fg-dim); }
    .code-chip code { letter-spacing: .14em; font-weight: 600; }
    .code-chip .copied { color: #6ee7b7; font-weight: 700; }

    .instructor-tag {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 12.5px; color: var(--fg-dim);
    }
    .instructor-tag app-icon { font-size: 13px; color: var(--accent); }

    .link-btn {
      background: transparent; border: none; color: var(--accent);
      cursor: pointer; font-size: 13px; padding: 0; min-height: auto;
    }
    .link-btn:hover { text-decoration: underline; }
    .link-btn.danger { color: var(--danger); }
    .link-btn:disabled { opacity: .5; cursor: default; text-decoration: none; }

    .joined-right { display: flex; align-items: center; gap: 14px; }

    .invite-note {
      display: flex; align-items: center; gap: 8px;
      margin: 12px 0 0; padding: 9px 12px; border-radius: 8px;
      font-size: 13px; color: var(--fg);
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    }
    .invite-note app-icon { font-size: 15px; color: var(--accent); flex: 0 0 auto; }

    .consent-note {
      display: flex; align-items: flex-start; gap: 8px;
      margin: 14px 0 0; font-size: 12px; line-height: 1.5; color: var(--fg-dim);
    }
    .consent-note app-icon { font-size: 14px; color: var(--accent); flex: 0 0 auto; margin-top: 1px; }

    /* ── Student progress table (scoped copy of admin board-table) ── */
    .students { margin-top: 14px; overflow-x: auto; }
    .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .data-table th, .data-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
    .data-table th { color: var(--fg-dim); font-weight: 500; font-size: 12px; }
    .board-table th.num, .board-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .data-table tr.inactive td { opacity: .55; }
    .dim { color: var(--fg-dim); }
    .s-name { font-weight: 500; }
    .s-email { font-size: 11px; margin-top: 2px; }
    .stage-chip {
      display: inline-block; font-size: 12px; padding: 2px 10px; border-radius: 999px;
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
    }
    .comp-val { font-weight: 500; color: var(--fg); }
    .lapsed-tag { margin-left: 6px; font-size: 11px; color: var(--fg-dim); white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
    .lapsed-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-dim); display: inline-block; }

    .err { color: var(--danger); margin: 0 0 10px; }
    .skel-line { height: 14px; border-radius: 6px; margin: 8px 0; background: var(--user-bg); }
    .skel-line.w40 { width: 40%; } .skel-line.w70 { width: 70%; }

    /* ── Phase 3: consent toggle ── */
    .consent-toggle {
      display: flex; align-items: flex-start; gap: 8px;
      margin-top: 10px; padding-top: 10px;
      border-top: 1px solid var(--border);
      font-size: 12.5px; color: var(--fg-dim); cursor: pointer; line-height: 1.4;
    }
    .consent-toggle input { margin-top: 2px; flex: 0 0 auto; accent-color: var(--accent); cursor: pointer; }
    .consent-toggle:hover span { color: var(--fg); }

    .actions-cell { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
    .no-access { display: inline-flex; }
    .no-access app-icon { font-size: 13px; }

    /* ── Phase 3: instructor drilldown modal ── */
    .modal-backdrop {
      position: fixed; inset: 0; z-index: 80;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
    }
    .drill-modal {
      position: fixed; z-index: 81;
      top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(720px, 92vw); max-height: 86vh; display: flex; flex-direction: column;
      background: var(--assistant-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
      border-radius: 14px; box-shadow: 0 24px 60px -16px rgba(0, 0, 0, 0.7);
      overflow: hidden;
    }
    .drill-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 16px; border-bottom: 1px solid var(--border); flex: 0 0 auto;
    }
    .drill-head-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .drill-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x-btn {
      background: transparent; border: none; color: var(--fg-dim);
      font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 6px;
    }
    .x-btn:hover { color: var(--fg); background: var(--user-bg); }
    .drill-body { padding: 16px; overflow-y: auto; }

    .sess-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
    .sess-row {
      display: flex; align-items: center; gap: 12px; width: 100%;
      padding: 10px 12px; border-radius: 8px; cursor: pointer; text-align: left;
      background: color-mix(in srgb, var(--accent) 3%, transparent);
      border: 1px solid var(--border); color: var(--fg); font: inherit; font-size: 13px;
      transition: border-color .15s ease;
    }
    .sess-row:hover { border-color: var(--accent); }
    .sess-char { font-weight: 500; }
    .sess-msgs { margin-left: auto; }
    .sess-go { color: var(--accent); }

    .sd-meta { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
    .sd-block { margin-bottom: 18px; }
    .sd-block .section-label { display: block; margin-bottom: 8px; }
    .fb-text {
      margin: 0; padding: 12px 14px; border-radius: 8px;
      background: color-mix(in srgb, var(--accent) 4%, var(--user-bg));
      border: 1px solid var(--border);
      font: inherit; font-size: 13px; line-height: 1.55; color: var(--fg);
      white-space: pre-wrap; word-break: break-word;
    }
    .transcript { display: flex; flex-direction: column; gap: 10px; }
    .msg { display: flex; flex-direction: column; gap: 3px; max-width: 85%; }
    .msg.mine { align-self: flex-end; align-items: flex-end; }
    .msg-role { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--fg-dim); }
    .msg-bubble {
      padding: 9px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.5;
      background: var(--user-bg); border: 1px solid var(--border); white-space: pre-wrap;
    }
    .msg.mine .msg-bubble {
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }

    @media (max-width: 560px) {
      .cohort-main { align-items: flex-start; }
      .cohort-tools { width: 100%; justify-content: space-between; }
      .msg { max-width: 100%; }
    }
  `],
})
export class CohortsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  protected i18n = inject(I18nService);

  loading = signal(true);
  error = signal<string | null>(null);
  data = signal<CohortList | null>(null);

  isInstructor = computed(() => this.auth.user()?.isInstructor === true);

  // Create-cohort form
  newName = signal('');
  creating = signal(false);

  // Join form
  joinCode = signal('');
  joining = signal(false);

  // Per-group detail (instructor)
  selectedId = signal<number | null>(null);
  detail = signal<CohortDetail | null>(null);
  detailLoading = signal(false);

  copiedCode = signal<string | null>(null);
  copiedLink = signal<string | null>(null);

  // Membership lifecycle in-flight markers (keyed by id so one row's
  // button spins without locking the rest).
  memberBusy = signal<number | null>(null);
  leaveBusy = signal<number | null>(null);
  deletingId = signal<number | null>(null);

  // Phase 3 — student consent toggle + instructor session drilldown
  consentBusy = signal<number | null>(null);
  drillStudent = signal<{ cohortId: number; row: CohortStudentRow } | null>(null);
  drillSessions = signal<StudentSessionRow[] | null>(null);
  drillLoading = signal(false);
  drillDetail = signal<StudentSessionDetail | null>(null);
  drillDetailLoading = signal(false);

  /** True when the page was opened via an /cohorts/join/:code invite link
   *  — surfaces a short banner and pre-fills the join code. */
  viaInvite = signal(false);

  constructor() {
    // Invite-link entry: /cohorts/join/:code pre-fills the join field so
    // the student just confirms (explicit click = consent), rather than
    // auto-joining on navigation.
    const code = this.route.snapshot.paramMap.get('code');
    if (code) {
      this.joinCode.set(code.trim().toUpperCase().slice(0, 6));
      this.viaInvite.set(true);
    }
    void this.reload();
  }

  async reload() {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.api.listCohorts());
    } catch (e: unknown) {
      this.error.set(this.msg(e, this.i18n.t('cohorts.errLoadCohorts')));
    } finally {
      this.loading.set(false);
    }
  }

  async create(ev: Event) {
    ev.preventDefault();
    const name = this.newName().trim();
    if (!name || this.creating()) return;
    this.creating.set(true);
    try {
      const created = await this.api.createCohort(name);
      // Prepend to the owned list with a zero member count.
      this.data.update((d) =>
        d ? { ...d, owned: [{ ...created, memberCount: 0 }, ...d.owned] } : d,
      );
      this.newName.set('');
    } catch (e: unknown) {
      alert(this.msg(e, this.i18n.t('cohorts.errCreateCohort')));
    } finally {
      this.creating.set(false);
    }
  }

  async join(ev: Event) {
    ev.preventDefault();
    const code = this.joinCode().trim().toUpperCase();
    if (code.length < 4 || this.joining()) return;
    this.joining.set(true);
    try {
      await this.api.joinCohort(code);
      this.joinCode.set('');
      this.viaInvite.set(false);
      // Reload so the joined list reflects the new membership (and dedups
      // if they were already in it).
      await this.reload();
    } catch (e: unknown) {
      alert(this.msg(e, this.i18n.t('cohorts.errJoin')));
    } finally {
      this.joining.set(false);
    }
  }

  /** Student leaves a group; drop it from the joined list on success. */
  async leave(c: JoinedCohort) {
    if (!confirm(this.i18n.t('cohorts.confirmLeave', { name: c.name }))) return;
    this.leaveBusy.set(c.id);
    try {
      await this.api.leaveCohort(c.id);
      this.data.update((d) =>
        d ? { ...d, joined: d.joined.filter((x) => x.id !== c.id) } : d,
      );
    } catch (e: unknown) {
      alert(this.msg(e, this.i18n.t('cohorts.errLeave')));
    } finally {
      this.leaveBusy.set(null);
    }
  }

  /** Instructor deletes a whole cohort: drop it from the owned list. */
  async deleteCohort(c: OwnedCohort) {
    if (!confirm(this.i18n.t('cohorts.confirmDeleteGroup', { name: c.name }))) return;
    this.deletingId.set(c.id);
    try {
      await this.api.deleteCohort(c.id);
      if (this.selectedId() === c.id) {
        this.selectedId.set(null);
        this.detail.set(null);
      }
      this.data.update((d) =>
        d ? { ...d, owned: d.owned.filter((x) => x.id !== c.id) } : d,
      );
    } catch (e: unknown) {
      alert(this.msg(e, this.i18n.t('cohorts.errDeleteGroup')));
    } finally {
      this.deletingId.set(null);
    }
  }

  /** Student toggles per-cohort session-sharing consent (Phase 3). */
  async setConsent(c: JoinedCohort, ev: Event) {
    const input = ev.target as HTMLInputElement;
    const share = input.checked;
    this.consentBusy.set(c.id);
    try {
      await this.api.setCohortConsent(c.id, share);
      this.data.update((d) =>
        d
          ? { ...d, joined: d.joined.map((x) => (x.id === c.id ? { ...x, shareSessions: share } : x)) }
          : d,
      );
    } catch (e: unknown) {
      input.checked = !share; // revert on failure
      alert(this.msg(e, this.i18n.t('cohorts.errUpdateSetting')));
    } finally {
      this.consentBusy.set(null);
    }
  }

  /** Instructor opens a consenting student's session list. */
  async openStudent(det: CohortDetail, row: CohortStudentRow) {
    this.drillStudent.set({ cohortId: det.id, row });
    this.drillDetail.set(null);
    this.drillSessions.set(null);
    this.drillLoading.set(true);
    try {
      this.drillSessions.set(await this.api.getStudentSessions(det.id, row.userId));
    } catch (e: unknown) {
      alert(this.msg(e, this.i18n.t('cohorts.errLoadSessions')));
      this.closeStudent();
    } finally {
      this.drillLoading.set(false);
    }
  }

  closeStudent() {
    this.drillStudent.set(null);
    this.drillSessions.set(null);
    this.drillDetail.set(null);
  }

  backToList() {
    this.drillDetail.set(null);
  }

  /** Instructor opens one session's full detail (transcript + feedback). */
  async openSession(sessionId: number) {
    const ds = this.drillStudent();
    if (!ds) return;
    this.drillDetailLoading.set(true);
    try {
      this.drillDetail.set(await this.api.getStudentSession(ds.cohortId, ds.row.userId, sessionId));
    } catch (e: unknown) {
      alert(this.msg(e, this.i18n.t('cohorts.errLoadSession')));
    } finally {
      this.drillDetailLoading.set(false);
    }
  }

  /** Map a stored message role to a display label. */
  roleLabel(role: string): string {
    if (role === 'user') return this.i18n.t('cohorts.roleTherapist');
    if (role === 'assistant') return this.i18n.t('cohorts.rolePatient');
    return role;
  }

  /** Instructor removes a student: drop the row + decrement member count. */
  async removeStudent(det: CohortDetail, s: CohortStudentRow) {
    const name = s.displayName || s.email;
    if (!confirm(this.i18n.t('cohorts.confirmRemoveStudent', { name }))) return;
    this.memberBusy.set(s.userId);
    try {
      await this.api.removeCohortMember(det.id, s.userId);
      this.detail.update((d) =>
        d ? { ...d, students: d.students.filter((x) => x.userId !== s.userId) } : d,
      );
      this.data.update((data) =>
        data
          ? {
              ...data,
              owned: data.owned.map((c) =>
                c.id === det.id
                  ? { ...c, memberCount: Math.max(0, (c.memberCount ?? 1) - 1) }
                  : c,
              ),
            }
          : data,
      );
    } catch (e: unknown) {
      alert(this.msg(e, this.i18n.t('cohorts.errRemoveStudent')));
    } finally {
      this.memberBusy.set(null);
    }
  }

  async toggleDetail(c: OwnedCohort) {
    if (this.selectedId() === c.id) {
      this.selectedId.set(null);
      this.detail.set(null);
      return;
    }
    this.selectedId.set(c.id);
    this.detail.set(null);
    this.detailLoading.set(true);
    try {
      this.detail.set(await this.api.getCohort(c.id));
    } catch (e: unknown) {
      this.error.set(this.msg(e, this.i18n.t('cohorts.errLoadStudents')));
      this.selectedId.set(null);
    } finally {
      this.detailLoading.set(false);
    }
  }

  /** Copy a full shareable invite link (origin + /cohorts/join/CODE). */
  async copyLink(code: string) {
    const url = `${location.origin}/cohorts/join/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      this.copiedLink.set(code);
      setTimeout(() => {
        if (this.copiedLink() === code) this.copiedLink.set(null);
      }, 1800);
    } catch {
      // Clipboard blocked — no-op; the code chip still works to type manually.
    }
  }

  async copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      this.copiedCode.set(code);
      setTimeout(() => {
        if (this.copiedCode() === code) this.copiedCode.set(null);
      }, 1800);
    } catch {
      // Clipboard blocked — no-op; the code is visible to type manually.
    }
  }

  private msg(e: unknown, fallback: string): string {
    return (
      (e as { error?: { message?: string }; message?: string })?.error?.message ??
      (e as { message?: string })?.message ??
      fallback
    );
  }
}
