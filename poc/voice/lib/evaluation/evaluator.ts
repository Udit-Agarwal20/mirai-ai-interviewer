import { randomUUID } from 'node:crypto';
import { calculateTranscriptHash, computeWeightedTotal, getCriterionDefinition, validateScoreValue } from './contract';
import type {
  CriterionCode,
  EvaluationRecord,
  EvaluatorProvenance,
  FinalizedTranscript,
  RawCriterionScore,
  RawEvaluationOutput,
  ScoreOverride,
  TranscriptTurn,
  ValidatedCriterionScore
} from './types';
import { EvaluationError } from './types';
import { validateEvaluation, type ValidationOptions } from './validator';

/**
 * Provider-independent interface for receiving structured evaluation output
 * from an evaluation engine or future LLM adapter.
 */
export interface EvaluatorAdapter {
  readonly provenance: EvaluatorProvenance;
  evaluateTranscript(transcript: FinalizedTranscript): Promise<RawEvaluationOutput>;
}

export const SYNTHETIC_PROVENANCE: EvaluatorProvenance = {
  kind: 'synthetic_mock',
  model_id: 'mirai-mock-evaluator-v1',
  prompt_version: 'eval-rubric-prompt-v1',
  temperature: 0,
  is_synthetic: true,
  notice: 'Deterministic offline fixture evaluator for contract testing and validation. No live LLM was invoked.'
};

function extractSafeQuote(turn: TranscriptTurn, preferred: string[]): string {
  for (const p of preferred) {
    if (turn.student_response_text.includes(p)) {
      return p;
    }
  }
  const words = turn.student_response_text.trim().split(/\s+/).slice(0, 4).join(' ');
  return words || turn.student_response_text.trim();
}

/**
 * Synthetic mock evaluator implementing the EvaluatorAdapter interface.
 * Strictly uses deterministic heuristics and canned candidate responses
 * to simulate model structured output without any network or billable calls.
 */
export class SyntheticMockEvaluatorAdapter implements EvaluatorAdapter {
  readonly provenance: EvaluatorProvenance;

  constructor(customProvenance?: Partial<EvaluatorProvenance>) {
    this.provenance = {
      ...SYNTHETIC_PROVENANCE,
      ...customProvenance
    };
  }

  evaluateTranscriptSync(transcript: FinalizedTranscript): RawEvaluationOutput {
    const turns = transcript.turns ?? [];
    if (turns.length === 0) {
      throw new EvaluationError('EMPTY_TRANSCRIPT', 'Cannot generate evaluation for empty transcript');
    }

    const fullStudentText = turns.map(t => t.student_response_text).join(' ').toLowerCase();

    let scores: RawCriterionScore[];
    let feedbackLines: string[];

    if (fullStudentText.includes('atomically claim') || fullStudentText.includes('same intended effect')) {
      // Strong persona -> Benchmark vector [5, 4, 3, 2, 1] yielding exact total 70
      const turn1 = turns.find(t => t.ordinal === 1) || turns[0];
      const turn2 = turns.find(t => t.ordinal === 2) || turns[0];
      const turn3 = turns.find(t => t.ordinal === 3) || turn2;
      const turn4 = turns.find(t => t.ordinal === 4) || turn3;

      scores = [
        {
          criterion_code: 'conceptual_understanding',
          score: 5,
          rationale: 'Candidate accurately articulated the core definition of idempotency as operations having the same intended effect.',
          evidence: [{ turn_id: turn1.id, verbatim_quote: extractSafeQuote(turn1, ['same intended effect', 'Idempotency means']) }]
        },
        {
          criterion_code: 'depth_and_reasoning',
          score: 4,
          rationale: 'Explained how to prevent concurrent duplicate execution using atomic key claims and payload bindings.',
          evidence: [{ turn_id: turn2.id, verbatim_quote: extractSafeQuote(turn2, ['atomically claim a unique key', 'concurrent retries']) }]
        },
        {
          criterion_code: 'problem_solving',
          score: 3,
          rationale: 'Sound test design simulating race conditions and timeouts to verify single-effect guarantees.',
          evidence: [{ turn_id: turn4.id, verbatim_quote: extractSafeQuote(turn4, ['simulate a timeout after the write', 'concurrent requests']) }]
        },
        {
          criterion_code: 'practical_knowledge',
          score: 2,
          rationale: 'Demonstrated practical experience testing edge cases including conflicting payload submissions.',
          evidence: [{ turn_id: turn4.id, verbatim_quote: extractSafeQuote(turn4, ['test conflicting payloads', 'consistent results']) }]
        },
        {
          criterion_code: 'communication',
          score: 1,
          rationale: 'Explanations were concise with precise engineering terminology throughout.',
          evidence: [{ turn_id: turn1.id, verbatim_quote: extractSafeQuote(turn1, ['A retry must not create a second payment', 'its response may still differ']) }]
        }
      ];

      feedbackLines = [
        'Strong conceptual foundation on idempotency keys and API contract safety.',
        'Good understanding of atomic locking and idempotency key lifecycle under concurrency.',
        'Comprehensive testing methodology covering timeout recovery and conflicting payload validation.'
      ];
    } else if (fullStudentText.includes('repeating a request should usually be safe')) {
      // Partial persona -> Preset vector [3, 2, 2, 1, 3] yielding exact total 45
      const turn1 = turns[0];
      const turn2 = turns[1] || turns[0];

      scores = [
        {
          criterion_code: 'conceptual_understanding',
          score: 3,
          rationale: 'Recognized that repeating requests is related to safety, but lacked formal definition.',
          evidence: [{ turn_id: turn1.id, verbatim_quote: extractSafeQuote(turn1, ['Repeating a request should usually be safe', 'safe']) }]
        },
        {
          criterion_code: 'depth_and_reasoning',
          score: 2,
          rationale: 'Expressed explicit uncertainty about managing failures and concurrent requests.',
          evidence: [{ turn_id: turn2.id, verbatim_quote: extractSafeQuote(turn2, ['unsure how to handle failures and concurrent requests', 'failures']) }]
        },
        {
          criterion_code: 'problem_solving',
          score: 2,
          rationale: 'Struggled to structure an end-to-end strategy for failure recovery.',
          evidence: [{ turn_id: turn2.id, verbatim_quote: extractSafeQuote(turn2, ['handle failures', 'concurrent requests']) }]
        },
        {
          criterion_code: 'practical_knowledge',
          score: 1,
          rationale: 'Limited practical architectural context provided for high-scale distributed APIs.',
          evidence: [{ turn_id: turn1.id, verbatim_quote: extractSafeQuote(turn1, ['Repeating a request', 'safe']) }]
        },
        {
          criterion_code: 'communication',
          score: 3,
          rationale: 'Answers were honest regarding knowledge gaps and phrased politely.',
          evidence: [{ turn_id: turn2.id, verbatim_quote: extractSafeQuote(turn2, ['I am unsure how', 'unsure']) }]
        }
      ];

      feedbackLines = [
        'Basic familiarity with retry safety, but review is needed for atomic storage patterns.',
        'Strengthen understanding of concurrency controls and idempotency key caching.'
      ];
    } else if (fullStudentText.includes('lunch') || fullStudentText.includes('weather')) {
      // Off-topic persona -> Preset vector [0, 0, 0, 0, 1] yielding exact total 2
      const turn1 = turns[0];

      scores = [
        {
          criterion_code: 'conceptual_understanding',
          score: 0,
          rationale: 'Candidate deflected the technical question and introduced unrelated conversational topics.',
          evidence: [{ turn_id: turn1.id, verbatim_quote: extractSafeQuote(turn1, ['talk about lunch', 'lunch']) }]
        },
        {
          criterion_code: 'depth_and_reasoning',
          score: 0,
          rationale: 'No technical reasoning provided on the requested backend concepts.',
          evidence: []
        },
        {
          criterion_code: 'problem_solving',
          score: 0,
          rationale: 'Did not engage with the problem-solving prompts presented by the interviewer.',
          evidence: []
        },
        {
          criterion_code: 'practical_knowledge',
          score: 0,
          rationale: 'No practical or project knowledge demonstrated.',
          evidence: []
        },
        {
          criterion_code: 'communication',
          score: 1,
          rationale: 'Spoke clearly in grammatical English but refused to address the examination topic.',
          evidence: [{ turn_id: turn1.id, verbatim_quote: extractSafeQuote(turn1, ['Can we talk about lunch', 'lunch']) }]
        }
      ];

      feedbackLines = [
        'Candidate was off-topic and did not answer the technical questions asked.'
      ];
    } else {
      // Evasive / Minimal / "I don't know" persona -> [0, 0, 0, 0, 0] yielding total 0
      const turn1 = turns[0];
      const quote = extractSafeQuote(turn1, ["I don't know yet.", "don't know"]);

      scores = [
        {
          criterion_code: 'conceptual_understanding',
          score: 0,
          rationale: 'Candidate declined to answer or stated unfamiliarity with the topic.',
          evidence: [{ turn_id: turn1.id, verbatim_quote: quote }]
        },
        {
          criterion_code: 'depth_and_reasoning',
          score: 0,
          rationale: 'No technical elaboration offered.',
          evidence: []
        },
        {
          criterion_code: 'problem_solving',
          score: 0,
          rationale: 'No problem solving steps articulated.',
          evidence: []
        },
        {
          criterion_code: 'practical_knowledge',
          score: 0,
          rationale: 'No project or practical experience shared.',
          evidence: []
        },
        {
          criterion_code: 'communication',
          score: 0,
          rationale: 'Communication was minimal, declining the prompt.',
          evidence: [{ turn_id: turn1.id, verbatim_quote: quote }]
        }
      ];

      feedbackLines = [
        'Candidate acknowledged lack of familiarity with the requested topics.'
      ];
    }

    return {
      scores,
      feedback_lines: feedbackLines,
      claimed_total: 999, // Intentional dummy total to prove server ignores it
      model_id: this.provenance.model_id,
      prompt_version: this.provenance.prompt_version
    };
  }

  async evaluateTranscript(transcript: FinalizedTranscript): Promise<RawEvaluationOutput> {
    return this.evaluateTranscriptSync(transcript);
  }
}

/**
 * Service that orchestrates evaluation creation, evidence validation,
 * and attributable human overrides while maintaining immutable original scores.
 */
export class EvaluationService {
  /**
   * Synchronous evaluation execution for in-memory synchronous workflows.
   */
  evaluateSessionSync(
    transcript: FinalizedTranscript,
    adapter: EvaluatorAdapter,
    options?: ValidationOptions,
    rubricId = 'official-viva-rubric-v1',
    rubricVersion = 1,
    runNo = 1
  ): EvaluationRecord {
    const rawOutput = (adapter as SyntheticMockEvaluatorAdapter).evaluateTranscriptSync
      ? (adapter as SyntheticMockEvaluatorAdapter).evaluateTranscriptSync(transcript)
      : this.getFallbackRawOutput(transcript);

    const validation = validateEvaluation(transcript, rawOutput, adapter.provenance, options);

    if (!validation.valid) {
      throw new EvaluationError(
        'EVALUATION_VALIDATION_FAILED',
        `Evaluation failed validation: ${validation.issues.map(i => i.message).join('; ')}`,
        422,
        validation.issues
      );
    }

    const now = new Date().toISOString();
    const transcriptHash = calculateTranscriptHash(transcript.turns);

    // Verify transcript hash consistency if provided
    if (transcript.transcript_hash && transcript.transcript_hash !== transcriptHash) {
      throw new EvaluationError(
        'TRANSCRIPT_HASH_MISMATCH',
        'Finalized transcript hash does not match computed turn content digest',
        400
      );
    }

    return {
      id: randomUUID(),
      session_id: transcript.session_id,
      rubric_id: rubricId,
      rubric_version: rubricVersion,
      run_no: runNo,
      status: validation.review_required ? 'review_required' : 'complete',
      provenance: adapter.provenance,
      transcript_hash: transcriptHash,
      ai_total: validation.ai_total ?? null,
      final_total: validation.ai_total ?? null,
      scores: validation.validated_scores!,
      feedback_lines: rawOutput.feedback_lines || [],
      review_reasons: validation.review_reasons,
      overrides: [],
      created_at: now,
      completed_at: now
    };
  }

  /**
   * Evaluates a completed transcript using the given adapter (async interface),
   * performs strict validation, and returns an EvaluationRecord.
   */
  async evaluateSession(
    transcript: FinalizedTranscript,
    adapter: EvaluatorAdapter,
    options?: ValidationOptions,
    rubricId = 'official-viva-rubric-v1',
    rubricVersion = 1,
    runNo = 1
  ): Promise<EvaluationRecord> {
    const rawOutput = await adapter.evaluateTranscript(transcript);
    const validation = validateEvaluation(transcript, rawOutput, adapter.provenance, options);

    if (!validation.valid) {
      throw new EvaluationError(
        'EVALUATION_VALIDATION_FAILED',
        `Evaluation failed validation: ${validation.issues.map(i => i.message).join('; ')}`,
        422,
        validation.issues
      );
    }

    const now = new Date().toISOString();
    const transcriptHash = calculateTranscriptHash(transcript.turns);

    // Verify transcript hash consistency if provided
    if (transcript.transcript_hash && transcript.transcript_hash !== transcriptHash) {
      throw new EvaluationError(
        'TRANSCRIPT_HASH_MISMATCH',
        'Finalized transcript hash does not match computed turn content digest',
        400
      );
    }

    return {
      id: randomUUID(),
      session_id: transcript.session_id,
      rubric_id: rubricId,
      rubric_version: rubricVersion,
      run_no: runNo,
      status: validation.review_required ? 'review_required' : 'complete',
      provenance: adapter.provenance,
      transcript_hash: transcriptHash,
      ai_total: validation.ai_total ?? null,
      final_total: validation.ai_total ?? null,
      scores: validation.validated_scores!,
      feedback_lines: rawOutput.feedback_lines || [],
      review_reasons: validation.review_reasons,
      overrides: [],
      created_at: now,
      completed_at: now
    };
  }

  private getFallbackRawOutput(transcript: FinalizedTranscript): RawEvaluationOutput {
    return new SyntheticMockEvaluatorAdapter().evaluateTranscriptSync(transcript);
  }

  /**
   * Applies an attributable faculty score override to a criterion.
   * Keeps the original AI score and ai_total strictly immutable,
   * recomputes final_total, and appends to the override audit trail.
   */
  applyOverride(
    evaluation: EvaluationRecord,
    input: {
      criterion_code: CriterionCode;
      new_score: number;
      reason: string;
      reviewer_id: string;
    }
  ): EvaluationRecord {
    const { criterion_code, new_score, reason, reviewer_id } = input;

    // Validation
    const validScore = validateScoreValue(new_score);

    if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
      throw new EvaluationError(
        'INVALID_OVERRIDE_REASON',
        'Override reason must contain at least 10 non-whitespace characters',
        400
      );
    }

    if (!reviewer_id || typeof reviewer_id !== 'string' || !reviewer_id.trim()) {
      throw new EvaluationError('MISSING_REVIEWER_ID', 'Reviewer identifier is required', 400);
    }

    const targetCriterion = evaluation.scores.find(s => s.criterion_code === criterion_code);
    if (!targetCriterion) {
      throw new EvaluationError(
        'UNKNOWN_CRITERION',
        `Criterion '${criterion_code}' not found in evaluation`,
        404
      );
    }

    if (targetCriterion.score === null) {
      throw new EvaluationError(
        'UNSCORED_CRITERION_OVERRIDE',
        'Cannot override an unscored criterion without supporting evidence',
        400
      );
    }

    const currentScore = targetCriterion.effective_score ?? targetCriterion.score;
    const overrideRecord: ScoreOverride = {
      id: randomUUID(),
      criterion_code,
      old_score: currentScore,
      new_score: validScore,
      reason: reason.trim(),
      reviewer_id: reviewer_id.trim(),
      created_at: new Date().toISOString()
    };

    // Update scores with new effective_score while preserving original score
    const updatedScores: ValidatedCriterionScore[] = evaluation.scores.map(c => {
      if (c.criterion_code === criterion_code) {
        const def = getCriterionDefinition(criterion_code);
        return {
          ...c,
          effective_score: validScore,
          contribution: validScore * def.multiplier
        };
      }
      return c;
    });

    const newFinalTotal = computeWeightedTotal(
      updatedScores.map(c => ({ code: c.criterion_code, score: c.effective_score }))
    );

    return {
      ...evaluation,
      status: 'review_required', // Overridden evaluations require faculty audit
      scores: updatedScores,
      final_total: newFinalTotal,
      overrides: [...evaluation.overrides, overrideRecord],
      review_reasons: evaluation.review_reasons.concat(
        `Faculty override on ${targetCriterion.label}: ${currentScore} → ${validScore}. (${reviewer_id})`
      )
    };
  }

  /**
   * Masks evaluation details for student-facing views (OD-005 gate).
   */
  toStudentView(evaluation: EvaluationRecord | null): {
    evaluated: boolean;
    status: 'pending_faculty_release' | 'not_evaluated';
  } {
    if (!evaluation) {
      return { evaluated: false, status: 'not_evaluated' };
    }
    return { evaluated: true, status: 'pending_faculty_release' };
  }
}
