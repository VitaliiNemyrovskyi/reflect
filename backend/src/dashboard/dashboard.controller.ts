import { Controller, Get, Headers } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * GET /api/dashboard — one-shot aggregate for the logged-in home page.
   * Locale resolved from Accept-Language so the city pulse / diary
   * language match what the frontend i18n is showing.
   */
  @Get()
  async getDashboard(
    @CurrentUser() user: AuthUser,
    @Headers('accept-language') langHeader?: string,
  ) {
    const lang = langHeader?.split(/[-,;]/)[0].trim().toLowerCase() === 'en' ? 'en' : 'uk';
    return this.dashboard.getForUser(user.id, lang);
  }
}
