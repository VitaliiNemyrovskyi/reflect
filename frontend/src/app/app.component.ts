import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <!-- Ambient "blob" layer: a few fixed, blurred accent orbs that
         drift slowly behind everything. Each one has its own size,
         start position, and animation path so they never sync up
         visually. Pointer-events:none + z-index:-1 keeps them out of
         the way of all interactive content. -->
    <div class="ambient-blobs" aria-hidden="true">
      <div class="blob blob-1"></div>
      <div class="blob blob-2"></div>
      <div class="blob blob-3"></div>
      <div class="blob blob-4"></div>
    </div>
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
      position: relative;
      z-index: 1;
    }

    .ambient-blobs {
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 0;
    }
    .blob {
      position: absolute;
      border-radius: 50%;
      filter: blur(80px);
      will-change: transform;
      background: radial-gradient(
        circle at 50% 50%,
        color-mix(in srgb, var(--accent) 55%, transparent) 0%,
        color-mix(in srgb, var(--accent) 20%, transparent) 45%,
        transparent 75%
      );
    }
    .blob-1 {
      width: 420px;
      height: 420px;
      top: -8%;
      left: 6%;
      opacity: 0.55;
      animation: blob-1-float 32s ease-in-out infinite;
    }
    .blob-2 {
      width: 360px;
      height: 360px;
      top: 35%;
      right: -6%;
      opacity: 0.45;
      animation: blob-2-float 28s ease-in-out infinite;
    }
    .blob-3 {
      width: 480px;
      height: 480px;
      bottom: -10%;
      left: 22%;
      opacity: 0.45;
      animation: blob-3-float 40s ease-in-out infinite;
    }
    .blob-4 {
      width: 300px;
      height: 300px;
      top: 18%;
      left: 48%;
      opacity: 0.35;
      animation: blob-4-float 36s ease-in-out infinite;
    }

    /* Each blob follows a distinct path so they don't drift in lockstep.
       Translate values are kept under ~25% viewport so they stay broadly
       in their "zone" but visibly move. */
    @keyframes blob-1-float {
      0%, 100% { transform: translate(0, 0) scale(1); }
      33%      { transform: translate(120px, 180px) scale(1.1); }
      66%      { transform: translate(-60px, 240px) scale(0.95); }
    }
    @keyframes blob-2-float {
      0%, 100% { transform: translate(0, 0) scale(1); }
      33%      { transform: translate(-180px, -120px) scale(1.05); }
      66%      { transform: translate(-80px, 160px) scale(1.15); }
    }
    @keyframes blob-3-float {
      0%, 100% { transform: translate(0, 0) scale(1); }
      33%      { transform: translate(220px, -160px) scale(0.9); }
      66%      { transform: translate(-140px, -80px) scale(1.1); }
    }
    @keyframes blob-4-float {
      0%, 100% { transform: translate(0, 0) scale(1); }
      33%      { transform: translate(-200px, 100px) scale(1.2); }
      66%      { transform: translate(180px, -120px) scale(0.85); }
    }

    /* Honour the OS reduce-motion switch — blobs stay put but still
       give the ambient colour wash. */
    @media (prefers-reduced-motion: reduce) {
      .blob { animation: none; }
    }
  `],
})
export class AppComponent {
  // Touching ThemeService here eagerly instantiates it before the first
  // route renders, so the [data-theme] attribute is on <html> in time to
  // avoid a flash of the wrong palette.
  private theme = inject(ThemeService);
}
