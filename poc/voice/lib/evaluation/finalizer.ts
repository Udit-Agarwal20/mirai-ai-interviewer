import { calculateTranscriptHash } from './contract';
import type { FinalizedTranscript, TranscriptTurn, VivaPhase } from './types';
import { EvaluationError } from './types';

export interface FinalizableSession {
  readonly id: string;
  readonly student_id: string;
  readonly bank_id: string;
  readonly bank_version: number;
  status: 'active' | 'completed';
  readonly started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  current_question_id: string | null;
  readonly turns: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly question_id: string;
    readonly question: string;
    readonly response: string;
    readonly phase: string;
    readonly start_ms: number;
    readonly end_ms: number;
    readonly committed_at?: string;
  }>;
  finalized_transcript?: FinalizedTranscript | null;
}

const VALID_PHASES: readonly VivaPhase[] = ['warmup', 'fundamentals', 'depth', 'applied', 'wrapup'];

function normalizePhase(phase: string): VivaPhase {
  if (VALID_PHASES.includes(phase as VivaPhase)) {
    return phase as VivaPhase;
  }
  return 'fundamentals';
}

/**
 * Canonically finalizes a viva interview session transcript.
 * Enforces session eligibility, seals the session against further turns,
 * constructs ordered TranscriptTurn records, and computes the SHA-256 digest.
 * Idempotent: if already finalized with identical turns, returns existing record.
 */
export function finalizeSessionTranscript(
  session: FinalizableSession,
  reason = 'Session finalized'
): FinalizedTranscript {
  // Idempotency check: if session is already completed and transcript exists
  if (session.status === 'completed' && session.finalized_transcript) {
    const existing = session.finalized_transcript;
    const computedHash = calculateTranscriptHash(existing.turns);
    if (existing.transcript_hash === computedHash) {
      return existing;
    }
  }

  // 1. Verify eligibility
  if (session.status !== 'active' && session.status !== 'completed') {
    throw new EvaluationError(
      'INVALID_SESSION_STATE',
      `Session ${session.id} is in status '${session.status}', cannot finalize`
    );
  }

  // 2. Seal session against further turns
  const now = new Date().toISOString();
  session.status = 'completed';
  session.current_question_id = null;
  if (!session.ended_at) {
    session.ended_at = now;
  }
  if (!session.end_reason) {
    session.end_reason = reason;
  }

  // 3. Collect and sort turns in canonical order (ordinal ascending)
  const sortedTurns = [...session.turns].sort((a, b) => a.ordinal - b.ordinal);

  // 4, 5, 6. Construct canonical TranscriptTurns with preserved provenance and timestamps
  const canonicalTurns: TranscriptTurn[] = sortedTurns.map(t => ({
    id: t.id,
    ordinal: t.ordinal,
    question_id: t.question_id,
    question_text: t.question.trim(),
    student_response_text: t.response.trim(),
    phase: normalizePhase(t.phase),
    start_ms: t.start_ms,
    end_ms: t.end_ms,
    committed_at: t.committed_at || now
  }));

  // 7, 8. Compute canonical digest and construct FinalizedTranscript contract
  const transcriptHash = calculateTranscriptHash(canonicalTurns);

  const finalized: FinalizedTranscript = {
    session_id: session.id,
    student_id: session.student_id,
    bank_id: session.bank_id,
    bank_version: session.bank_version,
    status: 'completed',
    started_at: session.started_at,
    ended_at: session.ended_at,
    turns: canonicalTurns,
    transcript_hash: transcriptHash
  };

  // 9. Store in session
  session.finalized_transcript = finalized;

  return finalized;
}
