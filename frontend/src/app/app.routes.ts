import { Routes } from '@angular/router';
import { authGuard, guestOnlyGuard, landingGuard } from './auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestOnlyGuard],
    loadComponent: () =>
      import('./pages/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'register',
    canActivate: [guestOnlyGuard],
    loadComponent: () =>
      import('./pages/register.component').then((m) => m.RegisterComponent),
  },
  {
    path: 'auth/callback',
    loadComponent: () =>
      import('./pages/oauth-callback.component').then((m) => m.OAuthCallbackComponent),
  },
  {
    // Public marketing landing (prerendered for SEO). Guests see it;
    // authenticated users are redirected to /dashboard by landingGuard.
    path: '',
    canActivate: [landingGuard],
    data: {
      description:
        'Reflect — симулятор для майбутніх психотерапевтів: реалістичні сесії з AI-клієнтами, фідбек рівня супервізора та відстеження прогресу. 3 безкоштовні сесії.',
    },
    loadComponent: () =>
      import('./pages/landing.component').then((m) => m.LandingComponent),
  },
  {
    // Logged-in home: "living world dashboard" — city pulse, diary
    // feed, pending feedback, week stats, compact patient grid.
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/home.component').then((m) => m.HomeComponent),
  },
  {
    // Power-user route: full character grid with all filters
    // (modality, difficulty). Reachable from the home page's
    // "Усі пацієнти →" link when there are more than fit in the
    // compact grid.
    path: 'clients',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/characters-list.component').then((m) => m.CharactersListComponent),
  },
  {
    path: 'patient/new',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/patient-form.component').then((m) => m.PatientFormComponent),
  },
  {
    path: 'patient/:id/edit',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/patient-form.component').then((m) => m.PatientFormComponent),
  },
  {
    path: 'patient/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/patient-detail.component').then((m) => m.PatientDetailComponent),
  },
  {
    path: 'patient/:id/intro',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/intro.component').then((m) => m.IntroComponent),
  },
  // Backward-compat redirect
  {
    path: 'intro/:id',
    redirectTo: 'patient/:id/intro',
  },
  {
    path: 'session/:sessionId',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/chat.component').then((m) => m.ChatComponent),
  },
  {
    path: 'session/:sessionId/view',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/session-view.component').then((m) => m.SessionViewComponent),
  },
  {
    path: 'session/:sessionId/feedback',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/feedback.component').then((m) => m.FeedbackComponent),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/settings.component').then((m) => m.SettingsComponent),
  },
  {
    path: 'profile',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/profile.component').then((m) => m.ProfileComponent),
  },
  {
    // Gamification — competency radar, progression stage, badges.
    path: 'progress',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/progress.component').then((m) => m.ProgressComponent),
  },
  {
    // Teaching cohort mode — instructor creates groups + sees student
    // progress; students join by code. Page self-gates by role.
    path: 'cohorts',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/cohorts.component').then((m) => m.CohortsComponent),
  },
  {
    // Invite link — pre-fills the join code on the cohorts page so the
    // student just confirms. Same component, reads the :code param.
    path: 'cohorts/join/:code',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/cohorts.component').then((m) => m.CohortsComponent),
  },
  {
    path: 'admin',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/admin.component').then((m) => m.AdminComponent),
  },
  {
    // Public — anyone (signed in or out) should be able to read this.
    // It's the disclaimer + crisis resources page.
    path: 'safety',
    data: {
      title: 'Безпека та кризові ресурси',
      description:
        'Reflect — навчальний тренажер, а не справжня терапія. Кризові ресурси й контакти невідкладної допомоги.',
    },
    loadComponent: () =>
      import('./pages/safety.component').then((m) => m.SafetyComponent),
  },
  {
    // Public pricing page — used both as marketing landing for
    // anonymous visitors AND as comparison view for logged-in users
    // deciding whether to upgrade.
    path: 'pricing',
    data: {
      title: 'Тарифи',
      description:
        'Тарифи Reflect — безкоштовний пробний період і плани Lite, Pro, Master для практики психотерапії з AI-фідбеком.',
    },
    loadComponent: () =>
      import('./pages/pricing.component').then((m) => m.PricingComponent),
  },
  {
    // Public demo — shows a real Opus reviewer output on a sample
    // session. Used as the marketing entry point ("see what the AI
    // actually does before you sign up").
    path: 'demo',
    data: {
      title: 'Демо',
      description:
        'Подивися реальний розбір тренувальної сесії від AI-супервізора Reflect — перш ніж реєструватися.',
    },
    loadComponent: () =>
      import('./pages/demo.component').then((m) => m.DemoComponent),
  },
  {
    path: 'account/billing',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/account-billing.component').then((m) => m.AccountBillingComponent),
  },
  {
    // 3D force-directed visualization of the character/therapist/city
    // graph. Lazy-loaded — pulls in 3d-force-graph + three.js (~350KB)
    // only when the user opens it.
    path: 'network',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/network.component').then((m) => m.NetworkComponent),
  },
  { path: '**', redirectTo: '' },
];
