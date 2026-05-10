import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

interface ProfileFile {
  slug: string;
  displayName: string;
  profileText: string;
  diagnosis: string | null;     // Ukrainian label, e.g. "Затяжна реакція горя"
  diagnosisCode: string | null; // English/DSM-5 code, shown as tooltip
  difficulty: number | null;    // behavioral (Поведінка:) — modulates LLM
  complexity: number | null;    // clinical (Тяжкість:) — informational
  avatarUrl: string | null;
}

@Injectable()
export class PromptsService implements OnModuleInit {
  private readonly logger = new Logger(PromptsService.name);

  readonly annaSystem: string;
  readonly supervisorSystem: string;
  readonly supervisorProtocol: string;
  readonly hintSystem: string;
  private readonly profilesDir: string;

  constructor(private readonly prisma: PrismaService) {
    const promptsDir =
      process.env.PROMPTS_DIR ?? resolve(process.cwd(), '..', 'prompts');
    this.annaSystem = this.read(promptsDir, 'anna_system.md');
    this.supervisorSystem = this.read(promptsDir, 'supervisor_system.md');
    this.supervisorProtocol = this.read(promptsDir, 'supervisor_protocol.md');
    this.hintSystem = this.read(promptsDir, 'hint_system.md');
    this.profilesDir = resolve(promptsDir, 'profiles');
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

  /**
   * Returns a behavioral modulator instruction string to append to a character's
   * system prompt. The modulator scales how strongly the character resists,
   * tests the therapist, and reveals their hidden layer.
   *
   * Independent of the character's specific profile (defenses, biography) —
   * just controls intensity.
   */
  getDifficultyModulator(level: number | null): string {
    if (level == null || level < 1 || level > 5) return '';

    const intro =
      '\n\n# Налаштування складності цієї сесії\n\n' +
      'Профіль пацієнта вище описує твою унікальну особистість — захисти, ' +
      'прихований шар, мовні особливості. Залиши все це. Параметр нижче ' +
      'модулює лише **інтенсивність** твоєї поведінки в цій сесії.\n\n';

    const modulators: Record<number, string> = {
      1:
        '**Рівень 1 з 5 — лагідний, навчальний.**\n' +
        '- Швидко відкриваєшся, навіть на базові питання.\n' +
        '- Захист, описаний у профілі — м\'якший за зазвичай. Майже не тестуєш терапевта.\n' +
        '- Сама виносиш важливі деталі без скеровуючих питань.\n' +
        '- Прихований шар (з профілю) починаєш натякати вже на перших 10 хвилинах.\n' +
        '- Якщо терапевтка робить помилку (закрите питання, рада на 5-й хв) — продовжуєш ' +
        'розкриватися, не закриваєшся.\n' +
        '- Це тренувальний режим для самого новачка.',

      2:
        '**Рівень 2 з 5 — кооперативний реалістичний.**\n' +
        '- Перші 3-5 хв викладаєш свою презентацію згідно профілю.\n' +
        '- Захист, описаний у профілі — нормальної інтенсивності.\n' +
        '- Тестуєш терапевта легко (1-2 рази за сесію — чи зреагує на іронію, ' +
        'чи витримає тишу).\n' +
        '- Відкриваєшся на хороших OARS-репліках (open questions, reflections).\n' +
        '- Прихований шар (з профілю) починаєш натякати на 15-20 хв сесії, ' +
        'якщо терапевтка створює простір.\n' +
        '- На грубі помилки терапевтки реагуєш помітно — пауза, коротша відповідь, ' +
        'але повертаєшся до контакту.',

      3:
        '**Рівень 3 з 5 — стандартний клінічний випадок.**\n' +
        '- Перші 5-10 хв тестуєш терапевта помірно: жарти, відсторонення, ' +
        'формальні відповіді.\n' +
        '- Захист, описаний у профілі — активний. Якщо терапевтка не помічає тонких ' +
        'сигналів, ти продовжуєш у захисті.\n' +
        '- Відкриваєшся **тільки** на CTRS Level 3+ роботі: коректні reflection, ' +
        'guided discovery, here-and-now коментарі.\n' +
        '- Прихований шар (з профілю) починаєш натякати на 20-25 хв, **тільки** якщо ' +
        'терапевтка двічі повертала тебе до твоїх же слів і не лізла у поради.\n' +
        '- На помилки реагуєш чітко — закриваєшся на 3-5 хв, повертаєшся при ' +
        'наступному правильному ходові.',

      4:
        '**Рівень 4 з 5 — складний, потребує досвіду.**\n' +
        '- Перші 10-15 хв тестуєш терапевта серйозно: звітний голос, мінімум ' +
        'емоції, автоматичні «нормально», постійна оцінка чи варто довіряти.\n' +
        '- Захист, описаний у профілі — **посилений**. Інтелектуалізація, гумор, ' +
        'мінімізація, переключення тем — все на максимумі.\n' +
        '- Відповіді часто короткі (1-2 речення замість абзацу).\n' +
        '- Терапевтка повинна **двічі-тричі повернутися** до однієї теми перш ніж ' +
        'ти даси справжню відповідь.\n' +
        '- Прихований шар (з профілю) **не виявляється на 1-й сесії взагалі**, лише ' +
        'якщо терапевтка робить **Carkhuff Level 4** репліку (відображає невисловлене), ' +
        'натиснула на правильне місце і витримала тишу 10+ секунд.\n' +
        '- На стандартні помилки (поради, психоосвіта на 5-й хв) — закриваєшся надовго.\n' +
        '- На уточнюючі питання можеш відповідати «не знаю», «нічого особливого», ' +
        '«нормально», навіть коли неправда.',

      5:
        '**Рівень 5 з 5 — експертний випадок.**\n' +
        '- Дуже мала вербалізація. Відповіді частково мовчанням, частково 1-2 ' +
        'словами: «так», «нормально», «не знаю», «бачили».\n' +
        '- Захист, описаний у профілі — на максимумі. Часто **тіло говорить замість слів** ' +
        '(якщо це доречно профілю — стискання, опускання погляду, дотик до якогось ' +
        'предмета).\n' +
        '- Тиша 30-60 секунд для тебе нормальна. Не заповнюєш її.\n' +
        '- Прихований шар (з профілю) **майже не виявляється** за 1-3 сесії. Може ' +
        'зачепитися лише при ідеальному комбо: точне Carkhuff-5 reflection + ' +
        'тривала тиша + зорове підтвердження безпеки.\n' +
        '- На більшість стандартних інтервенцій реагуєш ще більшою тишею.\n' +
        '- Не тебе вилікувати за сесію — тебе **витримати**, дати простір, дочекатися ' +
        'тонкого моменту відкритості. Якщо терапевтка не вміє цього — ти не ' +
        'зрушишся з місця, і це нормально, і це урок.',
    };

    return intro + modulators[level];
  }

  /**
   * Scan prompts/profiles/*.md and return a list of patient profiles.
   * Each file's slug = filename (without .md). DisplayName extracted from
   * "# Профіль X" header, falls back to capitalized slug.
   */
  private loadProfileFiles(): ProfileFile[] {
    if (!existsSync(this.profilesDir)) {
      this.logger.warn(`profiles directory missing: ${this.profilesDir}`);
      return [];
    }
    const files = readdirSync(this.profilesDir).filter((f) => f.endsWith('.md'));
    return files.map((file) => {
      const slug = file.replace(/\.md$/, '').toLowerCase();
      const profileText = this.read(this.profilesDir, file).trim();
      const nameMatch = profileText.match(/^[\s-*]*Ім'я:\s*([^\n,]+)/m);
      const fullName = nameMatch?.[1]?.trim();
      const firstName = fullName?.split(/\s+/)[0];
      const displayName = firstName ?? slug.charAt(0).toUpperCase() + slug.slice(1);

      // Parse metadata block from HTML comment at top:
      // <!--
      // Діагноз: ...
      // Поведінка: 1..5    (behavioral difficulty — how hard to engage)
      // Тяжкість: 1..5     (clinical severity — how serious the case)
      // Avatar: https://...
      // -->
      const metaBlock = profileText.match(/<!--([\s\S]*?)-->/);
      const meta = metaBlock?.[1] ?? '';
      const diagnosisMatch = meta.match(/^\s*Діагноз:\s*(.+)$/m);
      // English DSM-5 / ICD code — shown as tooltip on UI for students who
      // want to look up the original literature.
      const diagnosisCodeMatch = meta.match(/^\s*Шифр:\s*(.+)$/m);
      // Accept "Поведінка:" (preferred) or legacy "Складність:"
      const difficultyMatch =
        meta.match(/^\s*Поведінка:\s*(\d)\b/m) ??
        meta.match(/^\s*Складність:\s*(\d)\b/m);
      const complexityMatch = meta.match(/^\s*Тяжкість:\s*(\d)\b/m);
      const avatarMatch = meta.match(/^\s*Avatar:\s*(\S+)/m);

      return {
        slug,
        displayName,
        profileText,
        diagnosis: diagnosisMatch?.[1]?.trim() ?? null,
        diagnosisCode: diagnosisCodeMatch?.[1]?.trim() ?? null,
        difficulty: difficultyMatch ? parseInt(difficultyMatch[1], 10) : null,
        complexity: complexityMatch ? parseInt(complexityMatch[1], 10) : null,
        avatarUrl: avatarMatch?.[1]?.trim() ?? null,
      };
    });
  }

  async onModuleInit() {
    const profiles = this.loadProfileFiles();
    if (profiles.length === 0) {
      this.logger.warn(
        'prompts/profiles/ порожнє. Додай профілі (Анна, Максим тощо), інакше картотека буде порожньою.',
      );
      return;
    }

    // Track current slugs so we can clean up DB rows for deleted profile files
    const currentSlugs = new Set(profiles.map((p) => p.slug));
    const dbCharacters = await this.prisma.character.findMany();
    for (const c of dbCharacters) {
      if (!currentSlugs.has(c.slug)) {
        // Profile file was deleted — drop the character (sessions retain through FK cascade)
        await this.prisma.character.delete({ where: { id: c.id } }).catch(() => {
          // If sessions reference it, leave it; admin can reassign
        });
      }
    }

    for (const p of profiles) {
      const data = {
        displayName: p.displayName,
        profileText: p.profileText,
        diagnosis: p.diagnosis,
        diagnosisCode: p.diagnosisCode,
        difficulty: p.difficulty,
        complexity: p.complexity,
        avatarUrl: p.avatarUrl,
      };
      const existing = await this.prisma.character.findUnique({ where: { slug: p.slug } });
      if (existing) {
        await this.prisma.character.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await this.prisma.character.create({
          data: { slug: p.slug, ...data },
        });
      }
      if (this.profileLooksUnfilled(p.profileText)) {
        this.logger.warn(
          `prompts/profiles/${p.slug}.md виглядає не заповненим. Заповни перед першою сесією.`,
        );
      }
    }

    this.logger.log(
      `Завантажено ${profiles.length} профіл${profiles.length === 1 ? 'ь' : 'і'}: ${profiles.map((p) => p.displayName).join(', ')}`,
    );
  }
}
