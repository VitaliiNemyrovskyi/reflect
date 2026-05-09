import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { TtsService } from './tts.service';
import { Public } from '../auth/public.decorator';

class SynthesizeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
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
  async synthesize(@Body() dto: SynthesizeDto, @Res() res: Response) {
    const audio = await this.tts.synthesize(dto.text);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(audio.byteLength));
    res.send(audio);
  }
}
