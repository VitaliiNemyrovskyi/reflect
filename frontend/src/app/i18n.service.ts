import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type Lang = 'uk' | 'en';

// ── Translation dictionary ────────────────────────────────────────────────────

const T: Record<Lang, Record<string, string>> = {
  uk: {
    // Navigation / shell
    'nav.clients':        'Клієнти',
    'nav.profile':        'Профіль',
    'nav.settings':       'Налаштування',
    'nav.logout':         'Вийти',
    'nav.admin':          'Адмін',
    'nav.safety':         'Безпека та кризові ресурси →',
    'nav.demo':           'Демо',
    'nav.pricing':        'Тарифи',

    // Characters list
    'chars.page_title':   'Вибери клієнта для тренування',
    'chars.start':        'Почати сесію',
    'chars.sessions':     'Сесії',
    'chars.difficulty':   'Складність',
    'chars.no_chars':     'Немає доступних персонажів',
    'chars.new_patient':  '+ Новий пацієнт',
    'chars.complexity':   'Тяжкість',
    'chars.modality':     'Модальність',

    // Chat
    'chat.placeholder':   'Репліка терапевта…',
    'chat.send':          'Надіслати',
    'chat.end_session':   'Завершити сесію',
    'chat.notes':         'Нотатки',
    'chat.get_feedback':  'Отримати фідбек',
    'chat.note_placeholder': 'Нотатка для себе…',
    'chat.session_ended': 'Сесія завершена',
    'chat.end_confirm':   'Завершити сесію і отримати фідбек?',
    'chat.confirm_yes':   'Так, завершити',
    'chat.confirm_no':    'Продовжити',
    'chat.hint_label':    'Підказка',
    'chat.hint_button':   'Підказка ✦',
    'chat.tests':         'Тести',
    'chat.failed_label':  'Не вдалось надіслати',
    'chat.failed_retry':  'Повторити',
    'chat.failed_delete': 'Видалити',

    // Feedback / progress stages
    'feedback.loading':      'Готую фідбек…',
    'feedback.drafting':     'Перший супервізор готує чернетку розбору…',
    'feedback.reviewing':    'Другий супервізор перевіряє і покращує…',
    'feedback.refining':     'Третій супервізор шліфує і перевіряє цитати…',
    'feedback.skills':       'спеціалізованих агентів аналізують сесію паралельно…',
    'feedback.synthesizing': 'Синтезую знахідки агентів у фінальний фідбек…',
    'feedback.retry':        'Спробувати знову',
    'feedback.error':        'Помилка при генерації фідбеку',
    'feedback.back':         'До профілю',
    'feedback.new_session':  'Нова сесія',

    // Patient detail tabs
    'tab.overview':      'Огляд',
    'tab.profile':       'Профіль',
    'tab.sessions':      'Сесії',
    'tab.memory':        "Пам'ять",
    'tab.notes':         'Нотатки',
    'tab.progress':      'Прогрес',

    // Memory tab — kinds + empty state
    'memory.empty':      'Поки пам\'яті немає. З\'явиться після першої сесії та згодом збагатиться щоденником і соціальними зв\'язками.',
    'memory.kind.session': 'Із сесій з тобою',
    'memory.kind.diary':   'Між зустрічами',
    'memory.kind.social':  'Зі стосунків з близькими',
    'memory.kind.world':   'Із подій навколо',
    'memory.kind.seed':    'Біографічне',

    // Intro / landing
    'intro.tagline':     'Тренажер психотерапевта',
    'intro.subtitle':    'Практикуй сесії з AI-клієнтами. Отримуй клінічний фідбек рівня старшого супервізора.',
    'intro.cta':         'Спробувати безкоштовно',
    'intro.login':       'Увійти',
    'intro.demo':        'Переглянути демо',

    // Session intro (pre-chat screen).
    // 'label' is intentionally English in both locales — it's a
    // small-caps typographic device, not a translatable piece of copy.
    'session_intro.label':        'START SESSION',
    'session_intro.client_fallback': 'Клієнт',
    'session_intro.about':        'Зараз почнеться тренувальна сесія. Ваше завдання — провести терапевтичну розмову з клієнтом.',
    'session_intro.duration':     'Орієнтовно 20–30 хвилин. Коли захочете завершити — натисніть «Завершити сесію» згори чату.',
    'session_intro.privacy':      'Все, що ви напишете, побачить тільки супервізор-AI у фідбеку. Сесії нікуди не передаються.',
    'session_intro.entering':     '{name} заходить у кабінет…',

    // Auth
    'auth.login_title':    'Вхід',
    'auth.register_title': 'Реєстрація',
    'auth.email':          'Email',
    'auth.password':       'Пароль',
    'auth.login_btn':      'Увійти',
    'auth.register_btn':   'Зареєструватись',
    'auth.google':         'Увійти через Google',
    'auth.no_account':     'Немає акаунту?',
    'auth.have_account':   'Вже є акаунт?',

    // Pricing
    'pricing.title':     'Тарифи',
    'pricing.monthly':   '/місяць',
    'pricing.annual':    '/рік',
    'pricing.semester':  '/семестр',
    'pricing.trial':     '14 днів безкоштовно',
    'pricing.current':   'Поточний план',
    'pricing.upgrade':   'Оновити',
    'pricing.choose':    'Обрати',

    // Modality labels
    'modality.individual': 'Індивідуальна',
    'modality.couples':    'Парна',
    'modality.family':     'Сімейна',
    'modality.adolescent': 'Підліткова',
    'modality.crisis':     'Кризова',

    // Session labels
    'session.no_sessions': 'сесій ще не було',

    // General
    'general.loading':   'Завантаження…',
    'general.error':     'Щось пішло не так',
    'general.save':      'Зберегти',
    'general.cancel':    'Скасувати',
    'general.delete':    'Видалити',
    'general.edit':      'Редагувати',
    'general.back':      'Назад',
    'general.close':     'Закрити',
    'general.or':        'або',
  },

  en: {
    // Navigation / shell
    'nav.clients':        'Clients',
    'nav.profile':        'Profile',
    'nav.settings':       'Settings',
    'nav.logout':         'Sign out',
    'nav.admin':          'Admin',
    'nav.safety':         'Safety & Crisis Resources →',
    'nav.demo':           'Demo',
    'nav.pricing':        'Pricing',

    // Characters list
    'chars.page_title':   'Choose a client to practise with',
    'chars.start':        'Start session',
    'chars.sessions':     'Sessions',
    'chars.difficulty':   'Difficulty',
    'chars.no_chars':     'No clients available',
    'chars.new_patient':  '+ New client',
    'chars.complexity':   'Complexity',
    'chars.modality':     'Modality',

    // Modality labels (EN)
    'modality.individual': 'Individual',
    'modality.couples':    'Couples',
    'modality.family':     'Family',
    'modality.adolescent': 'Adolescent',
    'modality.crisis':     'Crisis',

    // Session labels (EN)
    'session.no_sessions': 'no sessions yet',

    // Chat
    'chat.placeholder':   'Therapist response…',
    'chat.send':          'Send',
    'chat.end_session':   'End session',
    'chat.notes':         'Notes',
    'chat.get_feedback':  'Get feedback',
    'chat.note_placeholder': 'Note to self…',
    'chat.session_ended': 'Session ended',
    'chat.end_confirm':   'End session and get feedback?',
    'chat.confirm_yes':   'Yes, end session',
    'chat.confirm_no':    'Continue',
    'chat.hint_label':    'Hint',
    'chat.hint_button':   'Hint ✦',
    'chat.tests':         'Tests',
    'chat.failed_label':  'Failed to send',
    'chat.failed_retry':  'Retry',
    'chat.failed_delete': 'Delete',

    // Feedback / progress stages
    'feedback.loading':      'Preparing feedback…',
    'feedback.drafting':     'First supervisor preparing draft…',
    'feedback.reviewing':    'Second supervisor reviewing and improving…',
    'feedback.refining':     'Third supervisor refining and checking citations…',
    'feedback.skills':       'specialist agents analysing session in parallel…',
    'feedback.synthesizing': 'Synthesising agent findings into final feedback…',
    'feedback.retry':        'Try again',
    'feedback.error':        'Error generating feedback',
    'feedback.back':         'Back to profile',
    'feedback.new_session':  'New session',

    // Patient detail tabs
    'tab.overview':      'Overview',
    'tab.profile':       'Profile',
    'tab.sessions':      'Sessions',
    'tab.memory':        'Memory',
    'tab.notes':         'Notes',
    'tab.progress':      'Progress',

    // Memory tab — kinds + empty state
    'memory.empty':      "No memories yet. They'll appear after the first session and grow with diary entries and social bonds.",
    'memory.kind.session': 'From sessions with you',
    'memory.kind.diary':   'Between sessions',
    'memory.kind.social':  'From close relationships',
    'memory.kind.world':   'From events around',
    'memory.kind.seed':    'Biographical',

    // Intro / landing
    'intro.tagline':     'Psychotherapy Training Simulator',
    'intro.subtitle':    'Practise therapy sessions with AI clients. Get feedback at senior supervisor level.',
    'intro.cta':         'Start free',
    'intro.login':       'Sign in',
    'intro.demo':        'View demo',

    // Session intro (pre-chat screen)
    'session_intro.label':        'START SESSION',
    'session_intro.client_fallback': 'Client',
    'session_intro.about':        'Your training session is about to start. Your task is to conduct a therapeutic conversation with the client.',
    'session_intro.duration':     'Approximately 20–30 minutes. When you want to end — click "End session" at the top of the chat.',
    'session_intro.privacy':      'Everything you write is seen only by the AI supervisor in feedback. Sessions are never shared.',
    'session_intro.entering':     '{name} is entering the room…',

    // Auth
    'auth.login_title':    'Sign in',
    'auth.register_title': 'Create account',
    'auth.email':          'Email',
    'auth.password':       'Password',
    'auth.login_btn':      'Sign in',
    'auth.register_btn':   'Create account',
    'auth.google':         'Continue with Google',
    'auth.no_account':     "Don't have an account?",
    'auth.have_account':   'Already have an account?',

    // Pricing
    'pricing.title':     'Pricing',
    'pricing.monthly':   '/month',
    'pricing.annual':    '/year',
    'pricing.semester':  '/semester',
    'pricing.trial':     '14 days free',
    'pricing.current':   'Current plan',
    'pricing.upgrade':   'Upgrade',
    'pricing.choose':    'Choose',

    // General
    'general.loading':   'Loading…',
    'general.error':     'Something went wrong',
    'general.save':      'Save',
    'general.cancel':    'Cancel',
    'general.delete':    'Delete',
    'general.edit':      'Edit',
    'general.back':      'Back',
    'general.close':     'Close',
    'general.or':        'or',
  },
};

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly http = inject(HttpClient);

  /** Reactive lang signal — components can read directly */
  readonly lang = signal<Lang>('uk');

  /**
   * Initialise language from the server config endpoint.
   * Called via APP_INITIALIZER so it resolves before any component renders.
   * Falls back to 'uk' on any error.
   */
  async init(): Promise<void> {
    // User's explicit preference always wins over the server default.
    // This lets them switch language once and have it persist across
    // page refreshes without needing a separate EN deployment.
    try {
      const stored = localStorage.getItem('reflect.lang') as Lang | null;
      if (stored === 'en' || stored === 'uk') {
        this.setLang(stored);
        return;
      }
    } catch { /* localStorage blocked (private browsing) — ignore */ }

    // No stored preference → fall back to server default (REFLECT_LANG).
    try {
      const cfg = await firstValueFrom(
        this.http.get<{ lang: string }>('/api/config'),
      );
      this.setLang((cfg?.lang as Lang) || 'uk');
    } catch {
      this.setLang('uk');
    }
  }

  /** Set active language and persist to localStorage for next visit */
  setLang(lang: Lang): void {
    this.lang.set(lang);
    try { localStorage.setItem('reflect.lang', lang); } catch {}
    // Set <html lang> for screen readers / SEO
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }

  /**
   * Translate a key. Optional `vars` map substitutes `{var}` placeholders
   * — keeps tiny templates (1 var, no plurals) inline without a full
   * ICU library. Missing keys fall back to the UK string, then to the
   * raw key (fail-safe so a broken translation never blanks the UI).
   */
  t(key: string, vars?: Record<string, string | number>): string {
    const raw = T[this.lang()][key] ?? T['uk'][key] ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
      String(vars[name] ?? `{${name}}`),
    );
  }

  /** True when the app is running in English mode */
  get isEn(): boolean {
    return this.lang() === 'en';
  }
}
