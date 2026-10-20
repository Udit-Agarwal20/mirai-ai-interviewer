/** Isolated demo DTOs, bridged to evaluation contracts. */
import type { EvaluationRecord, EvaluatorProvenance, FinalizedTranscript } from '../evaluation/types';

export type Scenario = 'strong' | 'partial' | 'none' | 'off_topic';
export type Branch = 'opening' | 'deeper' | 'partial' | 'next' | 'redirect';
export type Question = {
  id: string; external_ref: string; topic: string; difficulty: number;
  phase: 'fundamentals' | 'depth' | 'applied'; prompt: string;
  accepted_concepts: string[]; origin: 'faculty_generated'; branch: Branch;
};
export type Bank = { id: string; version: number; revision: number; status: 'draft' | 'approved';
  approved_by: string | null; approved_at: string | null; questions: Question[] };
export type Turn = { id: string; session_id: string; ordinal: number; question_id: string;
  question: string; phase: Question['phase']; response: string; scenario: Scenario;
  classification: Exclude<Branch, 'opening'>; decision: string; next_question_id: string | null;
  start_ms: number; end_ms: number; committed_at: string };
export type Criterion = { id: string; label: string; weight: number; score: number | null;
  final_score: number | null; rationale: string; evidence_turn_ids: string[] };
export type Override = { id: string; criterion_score_id: string; old_score: number; new_score: number;
  reason: string; reviewer_id: string; created_at: string };
export type Evaluation = { id: string; status: 'review_required' | 'complete'; fixture_version: string;
  transcript_hash: string; scores: Criterion[]; original_total: number | null; final_total: number | null;
  feedback: { text: string; evidence_turn_ids: string[] }[]; review_reasons: string[]; overrides: Override[];
  provenance?: EvaluatorProvenance };
export type DemoSession = { id: string; revision: number; student_id: string; status: 'active' | 'completed';
  bank_id: string; bank_version: number; consent: { accepted: true; version: string; at: string };
  duration_ms: number; remaining_ms: number; clock_phase: string; timing_mode: 'accelerated' | 'standard';
  started_at: string; ended_at: string | null; end_reason: string | null;
  current_question_id: string | null; asked: string[]; used_branches: Branch[];
  turns: Turn[]; finalized_transcript?: FinalizedTranscript | null;
  evaluation: Evaluation | null; evaluation_record?: EvaluationRecord | null };
export type Audit = { id: string; actor_id: string; action: string; resource_id: string; at: string; detail: string };
export type FacultyView = { workspace_id: string; subject: string; bank: Bank; sessions: DemoSession[]; audit: Audit[] };
export type StudentView = { subject: string; bank_status: Bank['status']; bank_version: number;
  session: Omit<DemoSession, 'evaluation' | 'evaluation_record' | 'finalized_transcript'> | null; question: Pick<Question,'id'|'prompt'|'phase'> | null;
  responses: { id: Scenario; label: string; text: string }[] };
