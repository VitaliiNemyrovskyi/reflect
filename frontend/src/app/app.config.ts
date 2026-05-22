import {
  ApplicationConfig,
  APP_INITIALIZER,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './auth.interceptor';
import { I18nService } from './i18n.service';

/**
 * Initialise I18nService before any component renders so `i18n.t()`
 * always returns the correct locale. The factory fetches /api/config
 * (fast, no auth) and sets the lang signal. Falls back to 'uk' silently.
 */
function initI18n(i18n: I18nService) {
  return () => i18n.init();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    {
      provide:    APP_INITIALIZER,
      useFactory: initI18n,
      deps:       [I18nService],
      multi:      true,
    },
  ],
};
