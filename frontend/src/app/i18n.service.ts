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
    'tab.notes':         'Нотатки',
    'tab.progress':      'Прогрес',

    // Intro / landing
    'intro.tagline':     'Тренажер психотерапевта',
    'intro.subtitle':    'Практикуй сесії з AI-клієнтами. Отримуй клінічний фідбек рівня старшого супервізора.',
    'intro.cta':         'Спробувати безкоштовно',
    'intro.login':       'Увійти',
    'intro.demo':        'Переглянути демо',

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
    'tab.notes':         'Notes',
    'tab.progress':      'Progress',

    // Intro / landing
    'intro.tagline':     'Psychotherapy Training Simulator',
    'intro.subtitle':    'Practise therapy sessions with AI clients. Get feedback at senior supervisor level.',
    'intro.cta':         'Start free',
    'intro.login':       'Sign in',
    'intro.demo':        'View demo',

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

  /** Translate a key. Returns the key itself if missing (fail-safe). */
  t(key: string): string {
    return T[this.lang()][key] ?? T['uk'][key] ?? key;
  }

  /** True when the app is running in English mode */
  get isEn(): boolean {
    return this.lang() === 'en';
  }
}
