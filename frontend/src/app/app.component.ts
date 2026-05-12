import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <main class="shell">
      <router-outlet />
    </main>
  `,
  styles: [`
    .shell {
      max-width: 1040px;
      margin: 0 auto;
      padding: 32px 20px 64px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
  `],
})
export class AppComponent {
  // Touching ThemeService here eagerly instantiates it before the first
  // route renders, so the [data-theme] attribute is on <html> in time to
  // avoid a flash of the wrong palette.
  private theme = inject(ThemeService);
}
