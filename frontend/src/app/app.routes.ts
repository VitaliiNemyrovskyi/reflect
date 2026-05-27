import { Routes } from '@angular/router';
import { authGuard, guestOnlyGuard } from './auth.guard';

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
    path: '',
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
    path: 'admin',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/admin.component').then((m) => m.AdminComponent),
  },
  {
    // Public — anyone (signed in or out) should be able to read this.
    // It's the disclaimer + crisis resources page.
    path: 'safety',
    loadComponent: () =>
      import('./pages/safety.component').then((m) => m.SafetyComponent),
  },
  {
    // Public pricing page — used both as marketing landing for
    // anonymous visitors AND as comparison view for logged-in users
    // deciding whether to upgrade.
    path: 'pricing',
    loadComponent: () =>
      import('./pages/pricing.component').then((m) => m.PricingComponent),
  },
  {
    // Public demo — shows a real Opus reviewer output on a sample
    // session. Used as the marketing entry point ("see what the AI
    // actually does before you sign up").
    path: 'demo',
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
