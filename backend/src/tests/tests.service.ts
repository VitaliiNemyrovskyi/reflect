import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One option a respondent can pick on a Likert item. value is what the
 * scorer sums; labelUa is the human-readable label shown to the
 * patient and rendered in the result card.
 */
export interface TestOption {
  value: number;
  labelUa: string;
}

/**
 * One item in a psychological test. Items are stored as `constructUa`
 * (a 5-10 word Ukrainian phrase capturing the clinical construct,
 * authored originally for this training tool) rather than as direct
 * translations of any specific published instrument. `reverse:true`
 * flags items that need value flipping before summing (PSS-10
 * positive-coping items).
 */
export interface TestItem {
  id: number;
  constructUa: string;
  reverse?: boolean;
  options?: TestOption[]; // overrides shared options if present
}

export interface InterpretationBand {
  min: number;
  max: number;
  level: string;
  labelUa: string;
  color: 'good' | 'neutral' | 'warn' | 'danger';
}

export interface PsychTest {
  key: string;
  name: string;
  fullName: string;
  fullNameUa: string;
  description: string;
  descriptionUa: string;
  domain: string;        // 'depression' | 'anxiety' | 'wellbeing' | 'stress' | ...
  ageGroup: string;      // 'adult' | 'adolescent' | 'either'
  itemCount: number;
  timeMinutes: number;
  scoreRange: [number, number];
  scaledScoreRange?: [number, number];
  scoreFormula?: string;
  instructionUa: string;
  options: TestOption[]; // shared default options
  items: TestItem[];
  interpretation: InterpretationBand[];
  interpretationScale?: 'raw' | 'scaled'; // which score the bands compare against
  clinicalCutoff?: number;
  specialFlags?: Array<{ condition: string; labelUa: string }>;
  source: string;
  tags: string[];
}

export interface ScoredResult {
  rawScore: number;
  scaledScore: number | null;
  severity: string;            // level key, e.g. "moderate"
  severityLabel: string;       // Ukrainian label
  color: InterpretationBand['color'];
  flags: string[];             // triggered special flags
}

@Injectable()
export class TestsService implements OnModuleInit {
  private readonly logger = new Logger(TestsService.name);
  private readonly testsDir: string;
  private tests: Map<string, PsychTest> = new Map();

  constructor() {
    const promptsDir =
      process.env.PROMPTS_DIR ?? resolve(process.cwd(), '..', 'prompts');
    this.testsDir = resolve(promptsDir, 'tests');
  }

  onModuleInit() {
    if (!existsSync(this.testsDir)) {
      this.logger.warn(`tests directory missing: ${this.testsDir}`);
      return;
    }
    const files = readdirSync(this.testsDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = readFileSync(resolve(this.testsDir, file), 'utf8');
        const parsed = JSON.parse(raw) as PsychTest;
        // Minimal sanity check — items count + interpretation present.
        if (!parsed.key || !Array.isArray(parsed.items) || parsed.items.length === 0) {
          this.logger.warn(`tests/${file}: invalid structure, skipping`);
          continue;
        }
        this.tests.set(parsed.key, parsed);
      } catch (e) {
        this.logger.warn(`tests/${file}: parse failed — ${(e as Error).message}`);
      }
    }
    const names = Array.from(this.tests.values()).map((t) => t.name).join(', ');
    this.logger.log(`Завантажено ${this.tests.size} тести: ${names}`);
  }

  /**
   * Catalog listing with optional search. Strips heavy `items` array so
   * the response is small — frontend fetches full test by key when the
   * user actually picks one. Search matches across name / fullName /
   * fullNameUa / descriptionUa / tags / domain (case-insensitive).
   */
  list(opts: { q?: string; domain?: string } = {}): Array<Omit<PsychTest, 'items'>> {
    let all = Array.from(this.tests.values());
    if (opts.domain) all = all.filter((t) => t.domain === opts.domain);
    if (opts.q) {
      const needle = opts.q.toLowerCase().trim();
      all = all.filter((t) => {
        const haystack = [
          t.name,
          t.fullName,
          t.fullNameUa,
          t.descriptionUa,
          t.domain,
          ...t.tags,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      });
    }
    return all.map(({ items: _items, ...rest }) => rest);
  }

  /**
   * Distinct domains across the loaded catalog. Used by the frontend
   * filter chips so they auto-populate from what's actually available.
   */
  listDomains(): string[] {
    const set = new Set<string>();
    for (const t of this.tests.values()) set.add(t.domain);
    return Array.from(set).sort();
  }

  getOrThrow(key: string): PsychTest {
    const t = this.tests.get(key);
    if (!t) throw new NotFoundException(`test not found: ${key}`);
    return t;
  }

  /**
   * Score raw answers from the AI patient. Each answer is {itemId,
   * value}. Validates value falls inside the item's option range,
   * applies reverse-scoring where flagged, sums, and looks up the
   * severity band.
   *
   * For WHO-5 and similar tests with scaled scores, the band lookup
   * targets the scaled value (controlled by interpretationScale).
   *
   * Throws BadRequest if answers don't cover all items.
   */
  score(test: PsychTest, answers: Array<{ itemId: number; value: number }>): ScoredResult {
    if (answers.length !== test.items.length) {
      throw new Error(
        `score: expected ${test.items.length} answers, got ${answers.length}`,
      );
    }
    let raw = 0;
    for (const item of test.items) {
      const ans = answers.find((a) => a.itemId === item.id);
      if (!ans) throw new Error(`score: missing answer for item ${item.id}`);
      const opts = item.options ?? test.options;
      const validValues = new Set(opts.map((o) => o.value));
      if (!validValues.has(ans.value)) {
        throw new Error(
          `score: item ${item.id} value ${ans.value} not in [${[...validValues].join(',')}]`,
        );
      }
      // Reverse-scored: max-value-in-options - actual value.
      const value = item.reverse
        ? Math.max(...opts.map((o) => o.value)) - ans.value
        : ans.value;
      raw += value;
    }

    const scaled =
      test.scaledScoreRange && test.scoreRange
        ? Math.round(
            (raw * test.scaledScoreRange[1]) / test.scoreRange[1],
          )
        : null;
    const lookupScore =
      test.interpretationScale === 'scaled' && scaled !== null ? scaled : raw;

    const band = test.interpretation.find(
      (b) => lookupScore >= b.min && lookupScore <= b.max,
    );
    if (!band) {
      throw new Error(`score: no interpretation band for ${lookupScore}`);
    }

    const flags: string[] = [];
    for (const f of test.specialFlags ?? []) {
      if (this.evalFlag(f.condition, answers)) flags.push(f.labelUa);
    }

    return {
      rawScore: raw,
      scaledScore: scaled,
      severity: band.level,
      severityLabel: band.labelUa,
      color: band.color,
      flags,
    };
  }

  /**
   * Tiny flag-condition evaluator. Supports only `itemN >= K` /
   * `itemN > K` / `itemN == K` for safety — no general eval. Used by
   * specialFlags entries like "item9 >= 1" for PHQ-9 suicide
   * ideation.
   */
  private evalFlag(condition: string, answers: Array<{ itemId: number; value: number }>): boolean {
    const m = condition.match(/^item(\d+)\s*(>=|>|==|<=|<)\s*(\d+)$/);
    if (!m) return false;
    const id = Number(m[1]);
    const op = m[2];
    const rhs = Number(m[3]);
    const ans = answers.find((a) => a.itemId === id);
    if (!ans) return false;
    switch (op) {
      case '>=': return ans.value >= rhs;
      case '>': return ans.value > rhs;
      case '==': return ans.value === rhs;
      case '<=': return ans.value <= rhs;
      case '<': return ans.value < rhs;
      default: return false;
    }
  }
}
