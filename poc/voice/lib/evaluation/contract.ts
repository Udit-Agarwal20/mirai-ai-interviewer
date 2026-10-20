import { createHash } from 'node:crypto';
import type { CriterionCode, RubricCriterion, TranscriptTurn } from './types';
import { EvaluationError } from './types';

/**
 * Official 5-dimension viva rubric defined in Student Challenge Section 5 (pp. 3–4).
 * Weights sum to 1.00 (100%).
 * With dimension scores from 0 to 5, integer contribution multipliers (weight% / 5)
 * are exactly 6, 5, 4, 3, 2, ensuring exact integer totals without rounding loss.
 */
export const OFFICIAL_RUBRIC_CRITERIA: readonly RubricCriterion[] = [
  {
    code: 'conceptual_understanding',
    label: 'Conceptual understanding',
    weight: 0.3,
    weightPercent: 30,
    multiplier: 6,
    position: 1,
    rubricDescription: 'Explains core concepts correctly in their own words'
  },
  {
    code: 'depth_and_reasoning',
    label: 'Depth and reasoning',
    weight: 0.25,
    weightPercent: 25,
    multiplier: 5,
    position: 2,
    rubricDescription: 'Handles follow-ups, explains trade-offs and "why"'
  },
  {
    code: 'problem_solving',
    label: 'Problem solving',
    weight: 0.2,
    weightPercent: 20,
    multiplier: 4,
    position: 3,
    rubricDescription: 'Breaks the applied problem into steps, reaches a sound approach'
  },
  {
    code: 'practical_knowledge',
    label: 'Practical / project knowledge',
    weight: 0.15,
    weightPercent: 15,
    multiplier: 3,
    position: 4,
    rubricDescription: 'Speaks concretely about what they built and how'
  },
  {
    code: 'communication',
    label: 'Communication',
    weight: 0.1,
    weightPercent: 10,
    multiplier: 2,
    position: 5,
    rubricDescription: 'Clear, structured, concise answers'
  }
] as const;

export const CRITERION_CODES: readonly CriterionCode[] = OFFICIAL_RUBRIC_CRITERIA.map(c => c.code);

const CRITERION_MAP = new Map<CriterionCode, RubricCriterion>(
  OFFICIAL_RUBRIC_CRITERIA.map(c => [c.code, c])
);

export function getCriterionDefinition(code: CriterionCode): RubricCriterion {
  const def = CRITERION_MAP.get(code);
  if (!def) {
    throw new EvaluationError('UNKNOWN_CRITERION', `Unknown criterion code: ${code}`);
  }
  return def;
}

export function validateScoreValue(val: unknown): number {
  if (
    typeof val !== 'number' ||
    !Number.isInteger(val) ||
    val < 0 ||
    val > 5 ||
    Number.isNaN(val) ||
    !Number.isFinite(val)
  ) {
    throw new EvaluationError(
      'INVALID_SCORE_RANGE',
      `Score must be an integer from 0 to 5, received: ${String(val)}`
    );
  }
  return val;
}

/**
 * Calculates the contribution of an integer score (0–5) toward the 100-point total.
 * Returns null if score is null (unscored).
 */
export function computeCriterionContribution(code: CriterionCode, score: number | null): number | null {
  if (score === null) return null;
  const validScore = validateScoreValue(score);
  const criterion = getCriterionDefinition(code);
  return validScore * criterion.multiplier;
}

/**
 * Server-authoritative computation of the 0–100 total.
 * Never accepts a model-provided total as authoritative.
 * Returns null if any score is null.
 * Throws EvaluationError if scores are missing, duplicated, or out of range.
 */
export function computeWeightedTotal(
  scores: ReadonlyArray<{ readonly code: CriterionCode; readonly score: number | null }>
): number | null {
  if (!Array.isArray(scores) || scores.length !== 5) {
    throw new EvaluationError(
      'INVALID_CRITERIA_COUNT',
      `Exactly 5 criteria scores required, received: ${scores?.length ?? 0}`
    );
  }

  const seen = new Set<CriterionCode>();
  let hasNull = false;
  let total = 0;

  for (const item of scores) {
    if (!CRITERION_MAP.has(item.code)) {
      throw new EvaluationError('UNKNOWN_CRITERION', `Invalid criterion code: ${item.code}`);
    }
    if (seen.has(item.code)) {
      throw new EvaluationError('DUPLICATE_CRITERION', `Duplicate criterion code: ${item.code}`);
    }
    seen.add(item.code);

    if (item.score === null) {
      hasNull = true;
    } else {
      const valid = validateScoreValue(item.score);
      const criterion = getCriterionDefinition(item.code);
      total += valid * criterion.multiplier;
    }
  }

  for (const code of CRITERION_CODES) {
    if (!seen.has(code)) {
      throw new EvaluationError('MISSING_CRITERION', `Missing required criterion: ${code}`);
    }
  }

  if (hasNull) return null;
  return total;
}

/**
 * Computes deterministic SHA-256 digest of normalized transcript turns.
 */
export function calculateTranscriptHash(turns: readonly TranscriptTurn[]): string {
  const normalized = turns.map(t => ({
    id: t.id,
    ordinal: t.ordinal,
    question_id: t.question_id,
    question_text: t.question_text.trim(),
    student_response_text: t.student_response_text.trim(),
    phase: t.phase,
    start_ms: t.start_ms,
    end_ms: t.end_ms
  }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
