import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/providers',
  '/api/tts/status',
];

function attach(req: HttpRequest<unknown>, token: string | null): HttpRequest<unknown> {
  if (!token) return req;
  return req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const isPublic = PUBLIC_PATHS.some((p) => req.url.includes(p));
  const accessToken = auth.accessToken();

  const authedReq = isPublic ? req : attach(req, accessToken);

  return next(authedReq).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status !== 401 || isPublic) {
        return throwError(() => err);
      }
      // Try refresh once
      return from(auth.refreshAccess()).pipe(
        switchMap((newToken: string | null): Observable<HttpEvent<unknown>> => {
          if (!newToken) {
            auth.forceLogout();
            return throwError(() => err);
          }
          return next(attach(req, newToken));
        }),
      );
    }),
  );
};
