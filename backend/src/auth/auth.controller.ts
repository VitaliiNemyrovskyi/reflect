import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { AuthService, type UserPreferences } from './auth.service';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto';
import { CurrentUser, type AuthUser } from './current-user.decorator';
import { Public } from './public.decorator';
import { GoogleStrategy } from './google.strategy';
import { FacebookStrategy } from './facebook.strategy';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('providers')
  providers() {
    return {
      local: true,
      google: GoogleStrategy.enabled,
      facebook: FacebookStrategy.enabled,
    };
  }

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.email, dto.password, dto.displayName);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@CurrentUser() user: AuthUser) {
    await this.auth.logout(user.id);
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.getProfile(user.id);
  }

  /**
   * PATCH — update displayName / bio. Email isn't editable (would need a
   * verify-by-email flow we don't have).
   */
  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() patch: UpdateProfileDto) {
    return this.auth.updateProfile(user.id, patch);
  }

  /**
   * Change password. Returns fresh tokens — frontend should replace its
   * stored access/refresh pair, since this rotates refresh hash.
   */
  @HttpCode(HttpStatus.OK)
  @Post('me/password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  @Get('me/preferences')
  getPreferences(@CurrentUser() user: AuthUser) {
    return this.auth.getPreferences(user.id);
  }

  /**
   * Patch — merges only the provided keys. Frontend sends e.g.
   * `{ hintsEnabled: false }` and untouched keys keep their values.
   * Unknown keys are silently dropped server-side.
   */
  @Patch('me/preferences')
  updatePreferences(
    @CurrentUser() user: AuthUser,
    @Body() patch: Partial<UserPreferences>,
  ) {
    return this.auth.updatePreferences(user.id, patch);
  }

  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleStart() {
    // passport redirects to Google
  }

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    return this.handleOAuthCallback(req, res);
  }

  @Public()
  @Get('facebook')
  @UseGuards(AuthGuard('facebook'))
  facebookStart() {
    // passport redirects to Facebook
  }

  @Public()
  @Get('facebook/callback')
  @UseGuards(AuthGuard('facebook'))
  async facebookCallback(@Req() req: Request, @Res() res: Response) {
    return this.handleOAuthCallback(req, res);
  }

  private async handleOAuthCallback(req: Request, res: Response) {
    const profile = req.user as {
      provider: 'google' | 'facebook';
      providerUserId: string;
      email: string;
      displayName?: string;
    };
    const result = await this.auth.findOrCreateOAuth(profile);
    const frontend = process.env.FRONTEND_URL ?? 'http://localhost:4200';
    const params = new URLSearchParams({
      access: result.accessToken,
      refresh: result.refreshToken,
    });
    res.redirect(`${frontend}/auth/callback?${params.toString()}`);
  }
}
