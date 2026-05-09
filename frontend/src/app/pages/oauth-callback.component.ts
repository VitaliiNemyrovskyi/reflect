import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-oauth-callback',
  standalone: true,
  template: `<p class="hint">Завершую вхід…</p>`,
  styles: [`.hint { color: var(--fg-dim); padding: 32px; }`],
})
export class OAuthCallbackComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);

  async ngOnInit() {
    const access = this.route.snapshot.queryParamMap.get('access');
    const refresh = this.route.snapshot.queryParamMap.get('refresh');
    if (!access || !refresh) {
      void this.router.navigate(['/login']);
      return;
    }
    await this.auth.applyOAuthTokens(access, refresh);
    void this.router.navigate(['/']);
  }
}
