import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

/**
 * Public configuration endpoint. Returns server-side feature flags the
 * frontend needs at startup — primarily the active language (REFLECT_LANG)
 * so the Angular app can render UI in the correct locale without a build
 * step or a separate bundle per language.
 *
 * Intentionally tiny: no service, no DB call. Pure env-var read.
 */
@Controller('config')
export class ConfigController {
  @Public()
  @Get()
  getConfig() {
    return {
      /** 'uk' (default) or 'en' — mirrors REFLECT_LANG on the backend */
      lang: process.env.REFLECT_LANG?.trim().toLowerCase() || 'uk',
      /** ISO 4217 currency code for pricing display */
      currency: process.env.REFLECT_LANG === 'en' ? 'GBP' : 'UAH',
    };
  }
}
