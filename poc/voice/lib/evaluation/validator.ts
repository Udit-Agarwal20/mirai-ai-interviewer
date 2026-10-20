import { CRITERION_CODES, computeWeightedTotal, getCriterionDefinition } from './contract';
import type {
  CriterionCode,
  EvaluatorProvenance,
  EvaluationValidationIssue,
  EvaluationValidationResult,
  FinalizedTranscript,
  RawCriterionScore,
  RawEvaluationOutput,
  TranscriptTurn,
  ValidatedCriterionScore,
  ValidatedEvidence
} from './types';

export interface ValidationOptions {
  /** If false, synthetic mock provenance will trigger an error instead of warning */
  readonly allowSyntheticMock?: boolean;
  /** Minimum characters for rationale (default: 10) */
  readonly minRationaleLength?: number;
  /** Minimum total student words before flagging short response (default: 15) */
  readonly minStudentWordCount?: number;
}

const DEFAULT_OPTIONS: Required<ValidationOptions> = {
  allowSyntheticMock: true,
  minRationaleLength: 10,
  minStudentWordCount: 15
};

/**
 * Normalizes text for verbatim substring comparison while preserving punctuation and words.
 */
function normalizeForMatching(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Finds exact or case-insensitive whitespace-normalized substring in student response text.
 * Returns [start, end] char range in original text, or null if not found.
 */
function findVerbatimSpan(container: string, quote: string): readonly [number, number] | null {
  const trimmedQuote = quote.trim();
  if (!trimmedQuote) return null;

  // 1. Direct exact index match
  const exactIndex = container.indexOf(trimmedQuote);
  if (exactIndex !== -1) {
    return [exactIndex, exactIndex + trimmedQuote.length];
  }

  // 2. Case-insensitive exact match
  const lowerContainer = container.toLowerCase();
  const lowerQuote = trimmedQuote.toLowerCase();
  const lowerIndex = lowerContainer.indexOf(lowerQuote);
  if (lowerIndex !== -1) {
    return [lowerIndex, lowerIndex + trimmedQuote.length];
  }

  // 3. Whitespace-normalized match
  const normContainer = normalizeForMatching(container);
  const normQuote = normalizeForMatching(trimmedQuote);
  const normIndex = normContainer.indexOf(normQuote);
  if (normIndex !== -1) {
    // Found in normalized text
    return [0, container.length];
  }

  return null;
}

/**
 * Validates an evaluation output against a finalized session transcript.
 * Enforces strict evidence grounding, Anti-Hallucination rules, and server-side arithmetic.
 */
export function validateEvaluation(
  transcript: FinalizedTranscript,
  rawOutput: RawEvaluationOutput,
  provenance: EvaluatorProvenance,
  options: ValidationOptions = {}
): EvaluationValidationResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const issues: EvaluationValidationIssue[] = [];
  const reviewReasons: string[] = [];

  // 1. Session status check
  if (transcript.status !== 'completed') {
    issues.push({
      code: 'UNFINALIZED_SESSION',
      field: 'transcript.status',
      severity: 'error',
      message: `Cannot evaluate unfinalized session: status is '${transcript.status}', expected 'completed'`
    });
  }

  // 2. Empty transcript check
  const turns = transcript.turns ?? [];
  const studentResponses = turns.filter(t => t.student_response_text && t.student_response_text.trim().length > 0);
  if (turns.length === 0 || studentResponses.length === 0) {
    issues.push({
      code: 'EMPTY_TRANSCRIPT',
      field: 'transcript.turns',
      severity: 'error',
      message: 'Transcript contains no student responses to evaluate'
    });
  }

  // Check total student response word count
  const totalStudentWords = studentResponses.reduce(
    (count, t) => count + t.student_response_text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  if (studentResponses.length > 0 && totalStudentWords < opts.minStudentWordCount) {
    reviewReasons.push(
      `Very short interview responses: only ${totalStudentWords} total words across ${studentResponses.length} turn(s).`
    );
  }

  // 3. Provenance check
  if (provenance.is_synthetic) {
    reviewReasons.push(
      `Synthetic test mock provenance (${provenance.model_id} · ${provenance.prompt_version}). Not an authorized live AI evaluation.`
    );
    if (!opts.allowSyntheticMock) {
      issues.push({
        code: 'SYNTHETIC_PROVENANCE',
        field: 'provenance.is_synthetic',
        severity: 'error',
        message: 'Synthetic mock evaluator is not permitted in production mode'
      });
    }
  }

  // 4. Raw model payload shape validation
  if (!rawOutput || typeof rawOutput !== 'object') {
    issues.push({
      code: 'MALFORMED_PAYLOAD',
      field: 'rawOutput',
      severity: 'error',
      message: 'Evaluation output must be an object'
    });
    return {
      valid: false,
      issues,
      review_required: true,
      review_reasons: ['Malformed evaluation output payload']
    };
  }

  if (!Array.isArray(rawOutput.scores)) {
    issues.push({
      code: 'MALFORMED_PAYLOAD',
      field: 'rawOutput.scores',
      severity: 'error',
      message: 'Evaluation output "scores" must be an array'
    });
    return {
      valid: false,
      issues,
      review_required: true,
      review_reasons: ['Evaluation output "scores" must be an array']
    };
  }

  // Build turn lookup map for fast retrieval
  const turnMap = new Map<string, TranscriptTurn>(turns.map(t => [t.id, t]));

  // 5. Criteria validation
  const seenCriteria = new Set<CriterionCode>();
  const scoreMap = new Map<CriterionCode, RawCriterionScore>();

  for (const item of rawOutput.scores) {
    if (!item || typeof item !== 'object') {
      issues.push({
        code: 'MALFORMED_PAYLOAD',
        field: 'rawOutput.scores[]',
        severity: 'error',
        message: 'Criterion score entry must be an object'
      });
      continue;
    }

    const code = item.criterion_code;
    if (!code || !CRITERION_CODES.includes(code)) {
      issues.push({
        code: 'MISSING_CRITERION',
        field: `scores[${String(code)}]`,
        severity: 'error',
        message: `Unknown or invalid criterion code: ${String(code)}`
      });
      continue;
    }

    if (seenCriteria.has(code)) {
      issues.push({
        code: 'DUPLICATE_CRITERION',
        field: `scores[${code}]`,
        criterion_code: code,
        severity: 'error',
        message: `Duplicate criterion entry for '${code}'`
      });
      continue;
    }

    seenCriteria.add(code);
    scoreMap.set(code, item);

    // Validate score range
    if (
      typeof item.score !== 'number' ||
      !Number.isInteger(item.score) ||
      item.score < 0 ||
      item.score > 5
    ) {
      issues.push({
        code: 'INVALID_SCORE_RANGE',
        field: `scores[${code}].score`,
        criterion_code: code,
        severity: 'error',
        message: `Score for '${code}' must be an integer between 0 and 5, received: ${String(item.score)}`
      });
    }

    // Validate rationale
    if (!item.rationale || typeof item.rationale !== 'string' || item.rationale.trim().length < opts.minRationaleLength) {
      issues.push({
        code: 'MALFORMED_RATIONALE',
        field: `scores[${code}].rationale`,
        criterion_code: code,
        severity: 'error',
        message: `Rationale for '${code}' must be at least ${opts.minRationaleLength} characters`
      });
    }

    // Validate evidence citations
    const evidenceList = Array.isArray(item.evidence) ? item.evidence : [];

    if (item.score > 0 && evidenceList.length === 0) {
      reviewReasons.push(`Criterion '${code}' awarded ${item.score}/5 without any cited evidence citations.`);
    }

    for (let eIdx = 0; eIdx < evidenceList.length; eIdx++) {
      const ev = evidenceList[eIdx];
      const evField = `scores[${code}].evidence[${eIdx}]`;

      if (!ev || typeof ev !== 'object') {
        issues.push({
          code: 'MALFORMED_PAYLOAD',
          field: evField,
          criterion_code: code,
          severity: 'error',
          message: 'Evidence citation must be an object'
        });
        continue;
      }

      if (!ev.turn_id || typeof ev.turn_id !== 'string') {
        issues.push({
          code: 'NONEXISTENT_TURN',
          field: `${evField}.turn_id`,
          criterion_code: code,
          severity: 'error',
          message: 'Evidence citation missing turn_id'
        });
        continue;
      }

      const turn = turnMap.get(ev.turn_id);
      if (!turn) {
        issues.push({
          code: 'NONEXISTENT_TURN',
          field: `${evField}.turn_id`,
          turn_id: ev.turn_id,
          criterion_code: code,
          severity: 'error',
          message: `Citation references turn '${ev.turn_id}' which does not exist in this session transcript`
        });
        continue;
      }

      if (!ev.verbatim_quote || typeof ev.verbatim_quote !== 'string' || !ev.verbatim_quote.trim()) {
        issues.push({
          code: 'HALLUCINATED_EVIDENCE',
          field: `${evField}.verbatim_quote`,
          turn_id: ev.turn_id,
          criterion_code: code,
          severity: 'error',
          message: 'Evidence citation has empty quote string'
        });
        continue;
      }

      // Check verbatim quote in student response text
      const quote = ev.verbatim_quote.trim();
      const studentMatch = findVerbatimSpan(turn.student_response_text, quote);

      if (!studentMatch) {
        // Check if quote was accidentally taken from interviewer question prompt instead
        const interviewerMatch = findVerbatimSpan(turn.question_text, quote);
        if (interviewerMatch) {
          issues.push({
            code: 'INTERVIEWER_TEXT_CITED',
            field: `${evField}.verbatim_quote`,
            turn_id: turn.id,
            criterion_code: code,
            severity: 'error',
            message: `Evidence citation "${quote}" cites the interviewer's prompt instead of candidate speech in turn ${turn.ordinal}`
          });
        } else {
          issues.push({
            code: 'HALLUCINATED_EVIDENCE',
            field: `${evField}.verbatim_quote`,
            turn_id: turn.id,
            criterion_code: code,
            severity: 'error',
            message: `Evidence citation "${quote}" does not match verbatim in turn ${turn.ordinal} response`
          });
        }
      }
    }
  }

  // Check for missing criteria
  for (const code of CRITERION_CODES) {
    if (!seenCriteria.has(code)) {
      issues.push({
        code: 'MISSING_CRITERION',
        field: `scores[${code}]`,
        criterion_code: code,
        severity: 'error',
        message: `Missing evaluation for mandatory rubric criterion: '${code}'`
      });
    }
  }

  // 6. Build validated criterion scores and server-side arithmetic if no blocking errors
  const hasErrors = issues.some(i => i.severity === 'error');
  if (hasErrors) {
    return {
      valid: false,
      issues,
      review_required: true,
      review_reasons: reviewReasons.concat(issues.filter(i => i.severity === 'error').map(i => i.message))
    };
  }

  const validatedScores: ValidatedCriterionScore[] = CRITERION_CODES.map(code => {
    const raw = scoreMap.get(code)!;
    const def = getCriterionDefinition(code);
    const validEvidence: ValidatedEvidence[] = (raw.evidence || [])
      .map(ev => {
        const turn = turnMap.get(ev.turn_id)!;
        const span = findVerbatimSpan(turn.student_response_text, ev.verbatim_quote)!;
        return {
          turn_id: turn.id,
          turn_ordinal: turn.ordinal,
          quote: ev.verbatim_quote.trim(),
          matched_char_range: span,
          start_ms: turn.start_ms,
          end_ms: turn.end_ms
        };
      });

    return {
      criterion_code: code,
      label: def.label,
      weight: def.weight,
      score: raw.score,
      effective_score: raw.score,
      contribution: raw.score * def.multiplier,
      rationale: raw.rationale.trim(),
      evidence: validEvidence
    };
  });

  const aiTotal = computeWeightedTotal(
    validatedScores.map(s => ({ code: s.criterion_code, score: s.score }))
  );

  return {
    valid: true,
    issues,
    review_required: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    validated_scores: validatedScores,
    ai_total: aiTotal
  };
}
