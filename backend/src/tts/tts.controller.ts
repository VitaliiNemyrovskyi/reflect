import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { TtsService } from './tts.service';
import { Public } from '../auth/public.decorator';
import { coerceLang } from '../common/lang';

class SynthesizeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;

  /** Either a bare lang code ('uk'|'en'|'fr'), a full edge-tts voice
   *  ID ('fr-FR-DeniseNeural'), or a Gemini voice name ('Aoede'). The
   *  sidecar classifies and routes to the right provider. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  voice?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  gender?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  age?: number;
}

@Controller('tts')
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  @Public()
  @Get('status')
  status() {
    return { enabled: this.tts.enabled };
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  async synthesize(
    @Body() dto: SynthesizeDto,
    @Headers('accept-language') langHeader: string | undefined,
    @Res() res: Response,
  ) {
    // Voice priority:
    //   1. Explicit dto.voice (full ID or bare lang)
    //   2. Accept-Language header (uk/en/fr)
    //   3. Default 'uk'
    const voiceOrLang = dto.voice?.trim() || coerceLang(langHeader);
    const { audio, contentType } = await this.tts.synthesize(dto.text, voiceOrLang, {
      gender: dto.gender ?? null,
      age: dto.age ?? null,
    });
    // Sidecar v2 returns audio/wav (Gemini) or audio/mpeg (edge). Frontend
    // `new Audio()` decodes both transparently, so we forward whatever the
    // sidecar produced.
    res.set('Content-Type', contentType);
    res.set('Content-Length', String(audio.byteLength));
    res.send(audio);
  }
}
