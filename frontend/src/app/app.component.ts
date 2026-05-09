import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

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
export class AppComponent {}
