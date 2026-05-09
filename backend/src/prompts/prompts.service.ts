import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PromptsService implements OnModuleInit {
  private readonly logger = new Logger(PromptsService.name);

  readonly annaSystem: string;
  readonly annaProfile: string;
  readonly supervisorSystem: string;
  readonly supervisorProtocol: string;

  constructor(private readonly prisma: PrismaService) {
    const promptsDir =
      process.env.PROMPTS_DIR ?? resolve(process.cwd(), '..', 'prompts');
    this.annaSystem = this.read(promptsDir, 'anna_system.md');
    this.annaProfile = this.read(promptsDir, 'anna_profile.md').trim();
    this.supervisorSystem = this.read(promptsDir, 'supervisor_system.md');
    this.supervisorProtocol = this.read(promptsDir, 'supervisor_protocol.md');
  }

  private read(dir: string, name: string): string {
    return readFileSync(resolve(dir, name), 'utf8');
  }

  fill(template: string, vars: Record<string, string>): string {
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v),
      template,
    );
  }

  profileLooksUnfilled(profileText: string): boolean {
    return profileText.length < 800 || /\[\s*заповн/i.test(profileText);
  }

  async onModuleInit() {
    const slug = 'anna';
    const existing = await this.prisma.character.findUnique({ where: { slug } });
    if (existing) {
      await this.prisma.character.update({
        where: { id: existing.id },
        data: { displayName: 'Анна', profileText: this.annaProfile },
      });
    } else {
      await this.prisma.character.create({
        data: { slug, displayName: 'Анна', profileText: this.annaProfile },
      });
    }
    if (this.profileLooksUnfilled(this.annaProfile)) {
      this.logger.warn(
        'prompts/anna_profile.md виглядає не заповненим. Заповни перед першою сесією.',
      );
    }
  }
}
