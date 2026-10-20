/**
 * Strongly typed evaluation and assessment contracts for Mirai AI Interviewer.
 * Aligned with official challenge specifications, docs/DB_API_Contracts/schema.sql,
 * and docs/DB_API_Contracts/openapi.yaml.
 */

export type CriterionCode =
  | 'conceptual_understanding'
  | 'depth_and_reasoning'
  | 'problem_solving'
  | 'practical_knowledge'
  | 'communication';

export type VivaPhase = 'warmup' | 'fundamentals' | 'depth' | 'applied' | 'wrapup';

export interface RubricCriterion {
  readonly code: CriterionCode;
  readonly label: string;
  readonly weight: number; // Decimal weight: 0.30, 0.25, 0.20, 0.15, 0.10
  readonly weightPercent: number; // 30, 25, 20, 15, 10
  readonly multiplier: number; // Integer contribution multiplier: 6, 5, 4, 3, 2
  readonly position: number; // 1 to 5
  readonly rubricDescription: string;
}

export interface TranscriptTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly question_id: string;
  readonly question_text: string;
  readonly student_response_text: string;
  readonly phase: VivaPhase;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly committed_at?: string;
}

export interface FinalizedTranscript {
  readonly session_id: string;
  readonly student_id: string;
  readonly bank_id: string;
  readonly bank_version: number;
  readonly status: 'completed' | 'active' | 'abandoned';
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly turns: readonly TranscriptTurn[];
  readonly transcript_hash: string;
}

export interface EvidenceCitation {
  readonly turn_id: string;
  readonly verbatim_quote: string;
}

export interface ValidatedEvidence {
  readonly turn_id: string;
  readonly turn_ordinal: number;
  readonly quote: string;
  readonly matched_char_range: readonly [number, number];
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface RawCriterionScore {
  readonly criterion_code: CriterionCode;
  readonly score: number;
  readonly rationale: string;
  readonly evidence: readonly EvidenceCitation[];
}

export interface RawEvaluationOutput {
  readonly scores: readonly RawCriterionScore[];
  readonly feedback_lines: readonly string[];
  readonly claimed_total?: number; // Strictly ignored by server; totals are always server-computed
  readonly model_id?: string;
  readonly prompt_version?: string;
  readonly raw_model_response?: unknown;
}

export interface EvaluatorProvenance {
  readonly kind: 'synthetic_mock' | 'deterministic_fixture' | 'live_llm';
  readonly model_id: string;
  readonly prompt_version: string;
  readonly temperature: number;
  readonly is_synthetic: boolean;
  readonly notice: string;
}

export interface ValidatedCriterionScore {
  readonly criterion_code: CriterionCode;
  readonly label: string;
  readonly weight: number;
  readonly score: number | null;
  readonly effective_score: number | null;
  readonly contribution: number | null;
  readonly rationale: string;
  readonly evidence: readonly ValidatedEvidence[];
}

export interface ScoreOverride {
  readonly id: string;
  readonly criterion_code: CriterionCode;
  readonly old_score: number;
  readonly new_score: number;
  readonly reason: string;
  readonly reviewer_id: string;
  readonly created_at: string;
}

export type EvaluationStatus =
  | 'queued'
  | 'running'
  | 'review_required'
  | 'complete'
  | 'failed';

export interface EvaluationRecord {
  readonly id: string;
  readonly session_id: string;
  readonly rubric_id: string;
  readonly rubric_version: number;
  readonly run_no: number;
  readonly status: EvaluationStatus;
  readonly provenance: EvaluatorProvenance;
  readonly transcript_hash: string;
  readonly ai_total: number | null;
  readonly final_total: number | null;
  readonly scores: readonly ValidatedCriterionScore[];
  readonly feedback_lines: readonly string[];
  readonly review_reasons: readonly string[];
  readonly overrides: readonly ScoreOverride[];
  readonly created_at: string;
  readonly completed_at: string | null;
}

export interface EvaluationValidationIssue {
  readonly code:
    | 'UNFINALIZED_SESSION'
    | 'EMPTY_TRANSCRIPT'
    | 'MISSING_CRITERION'
    | 'DUPLICATE_CRITERION'
    | 'INVALID_SCORE_RANGE'
    | 'MALFORMED_RATIONALE'
    | 'NONEXISTENT_TURN'
    | 'CROSS_SESSION_EVIDENCE'
    | 'INTERVIEWER_TEXT_CITED'
    | 'HALLUCINATED_EVIDENCE'
    | 'INSUFFICIENT_EVIDENCE'
    | 'MALFORMED_PAYLOAD'
    | 'SYNTHETIC_PROVENANCE';
  readonly field: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly turn_id?: string;
  readonly criterion_code?: CriterionCode;
}

export interface EvaluationValidationResult {
  readonly valid: boolean;
  readonly issues: readonly EvaluationValidationIssue[];
  readonly review_required: boolean;
  readonly review_reasons: readonly string[];
  readonly validated_scores?: readonly ValidatedCriterionScore[];
  readonly ai_total?: number | null;
}

export class EvaluationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'EvaluationError';
  }
}
