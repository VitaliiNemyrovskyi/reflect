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
    path: 'intro/:characterId',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/intro.component').then((m) => m.IntroComponent),
  },
  {
    path: 'session/:sessionId',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/chat.component').then((m) => m.ChatComponent),
  },
  {
    path: 'session/:sessionId/feedback',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/feedback.component').then((m) => m.FeedbackComponent),
  },
  { path: '**', redirectTo: '' },
];
