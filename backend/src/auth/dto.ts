import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  password!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

/**
 * PATCH /api/auth/me — partial profile update. Only the supplied fields
 * are touched. Empty string clears bio (sets to null).
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string;
}

/**
 * POST /api/auth/me/password — change password. currentPassword required
 * for local accounts; OAuth-only users (no hashedPassword) can SET an
 * initial password by passing an empty currentPassword.
 */
export class ChangePasswordDto {
  @IsString()
  @MaxLength(120)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  newPassword!: string;
}
