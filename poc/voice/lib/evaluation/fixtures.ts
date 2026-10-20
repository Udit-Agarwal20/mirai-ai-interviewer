import { calculateTranscriptHash } from './contract';
import type { FinalizedTranscript, TranscriptTurn } from './types';

const SESSION_STRONG = '11111111-1111-4111-8111-111111111111';
const SESSION_PARTIAL = '22222222-2222-4222-8222-222222222222';
const SESSION_OFFTOPIC = '33333333-3333-4333-8333-333333333333';
const SESSION_EVASIVE = '44444444-4444-4444-8444-444444444444';
const SESSION_SILENT = '55555555-5555-4555-8555-555555555555';
const SESSION_FOREIGN = '99999999-9999-4999-8999-999999999999';

export const strongTurns: readonly TranscriptTurn[] = [
  {
    id: 'turn-s1',
    ordinal: 1,
    question_id: 'q-idempotency-def',
    question_text: 'What does idempotency mean for an HTTP API?',
    student_response_text:
      'Idempotency means repeating an operation has the same intended effect as performing it once. A retry must not create a second payment; its response may still differ.',
    phase: 'fundamentals',
    start_ms: 0,
    end_ms: 30000
  },
  {
    id: 'turn-s2',
    ordinal: 2,
    question_id: 'q-concurrent-keys',
    question_text: 'How would you handle two simultaneous requests using the same idempotency key?',
    student_response_text:
      'I would atomically claim a unique key, bind it to the request payload, and store the result so concurrent retries cannot apply the effect twice.',
    phase: 'depth',
    start_ms: 30000,
    end_ms: 60000
  },
  {
    id: 'turn-s3',
    ordinal: 3,
    question_id: 'q-network-timeout',
    question_text: 'Consider a client repeating a request after a timeout. What property should remain unchanged?',
    student_response_text:
      'The underlying resource state and intended side effect must remain identical to a single successful execution.',
    phase: 'fundamentals',
    start_ms: 60000,
    end_ms: 90000
  },
  {
    id: 'turn-s4',
    ordinal: 4,
    question_id: 'q-test-duplicates',
    question_text: 'How would you test whether an API handles duplicate requests safely?',
    student_response_text:
      'I would send concurrent requests with the same key, simulate a timeout after the write, then assert one effect and consistent results. I would also test conflicting payloads.',
    phase: 'applied',
    start_ms: 90000,
    end_ms: 120000
  }
];

export const strongTranscript: FinalizedTranscript = {
  session_id: SESSION_STRONG,
  student_id: 'student-dev-strong',
  bank_id: 'bank-http-v1',
  bank_version: 1,
  status: 'completed',
  started_at: '2026-10-20T10:00:00.000Z',
  ended_at: '2026-10-20T10:02:00.000Z',
  turns: strongTurns,
  transcript_hash: calculateTranscriptHash(strongTurns)
};

export const partialTurns: readonly TranscriptTurn[] = [
  {
    id: 'turn-p1',
    ordinal: 1,
    question_id: 'q-idempotency-def',
    question_text: 'What does idempotency mean for an HTTP API?',
    student_response_text:
      'Repeating a request should usually be safe, but I am unsure how to handle failures and concurrent requests.',
    phase: 'fundamentals',
    start_ms: 0,
    end_ms: 30000
  },
  {
    id: 'turn-p2',
    ordinal: 2,
    question_id: 'q-concurrent-keys',
    question_text: 'How would you handle two simultaneous requests using the same idempotency key?',
    student_response_text:
      'Maybe you can check if the ID already exists in the table before inserting, but I am unsure how to handle failures and concurrent requests.',
    phase: 'depth',
    start_ms: 30000,
    end_ms: 60000
  }
];

export const partialTranscript: FinalizedTranscript = {
  session_id: SESSION_PARTIAL,
  student_id: 'student-dev-partial',
  bank_id: 'bank-http-v1',
  bank_version: 1,
  status: 'completed',
  started_at: '2026-10-20T10:10:00.000Z',
  ended_at: '2026-10-20T10:11:00.000Z',
  turns: partialTurns,
  transcript_hash: calculateTranscriptHash(partialTurns)
};

export const offTopicTurns: readonly TranscriptTurn[] = [
  {
    id: 'turn-o1',
    ordinal: 1,
    question_id: 'q-idempotency-def',
    question_text: 'What does idempotency mean for an HTTP API?',
    student_response_text: 'Can we talk about lunch instead of the API question? I am really hungry.',
    phase: 'fundamentals',
    start_ms: 0,
    end_ms: 30000
  }
];

export const offTopicTranscript: FinalizedTranscript = {
  session_id: SESSION_OFFTOPIC,
  student_id: 'student-dev-offtopic',
  bank_id: 'bank-http-v1',
  bank_version: 1,
  status: 'completed',
  started_at: '2026-10-20T10:20:00.000Z',
  ended_at: '2026-10-20T10:20:30.000Z',
  turns: offTopicTurns,
  transcript_hash: calculateTranscriptHash(offTopicTurns)
};

export const evasiveTurns: readonly TranscriptTurn[] = [
  {
    id: 'turn-e1',
    ordinal: 1,
    question_id: 'q-idempotency-def',
    question_text: 'What does idempotency mean for an HTTP API?',
    student_response_text: "I don't know yet.",
    phase: 'fundamentals',
    start_ms: 0,
    end_ms: 30000
  }
];

export const evasiveTranscript: FinalizedTranscript = {
  session_id: SESSION_EVASIVE,
  student_id: 'student-dev-evasive',
  bank_id: 'bank-http-v1',
  bank_version: 1,
  status: 'completed',
  started_at: '2026-10-20T10:30:00.000Z',
  ended_at: '2026-10-20T10:30:30.000Z',
  turns: evasiveTurns,
  transcript_hash: calculateTranscriptHash(evasiveTurns)
};

export const silentTranscript: FinalizedTranscript = {
  session_id: SESSION_SILENT,
  student_id: 'student-dev-silent',
  bank_id: 'bank-http-v1',
  bank_version: 1,
  status: 'completed',
  started_at: '2026-10-20T10:40:00.000Z',
  ended_at: '2026-10-20T10:40:15.000Z',
  turns: [],
  transcript_hash: calculateTranscriptHash([])
};

export const unfinalizedTranscript: FinalizedTranscript = {
  session_id: '66666666-6666-4666-8666-666666666666',
  student_id: 'student-dev-active',
  bank_id: 'bank-http-v1',
  bank_version: 1,
  status: 'active',
  started_at: '2026-10-20T10:50:00.000Z',
  ended_at: null,
  turns: strongTurns,
  transcript_hash: calculateTranscriptHash(strongTurns)
};

export const foreignSessionTranscript: FinalizedTranscript = {
  session_id: SESSION_FOREIGN,
  student_id: 'student-dev-foreign',
  bank_id: 'bank-http-v1',
  bank_version: 1,
  status: 'completed',
  started_at: '2026-10-20T11:00:00.000Z',
  ended_at: '2026-10-20T11:01:00.000Z',
  turns: [
    {
      id: 'turn-foreign-1',
      ordinal: 1,
      question_id: 'q-idempotency-def',
      question_text: 'What does idempotency mean for an HTTP API?',
      student_response_text: 'A foreign session response on database indexes.',
      phase: 'fundamentals',
      start_ms: 0,
      end_ms: 30000
    }
  ],
  transcript_hash: calculateTranscriptHash([
    {
      id: 'turn-foreign-1',
      ordinal: 1,
      question_id: 'q-idempotency-def',
      question_text: 'What does idempotency mean for an HTTP API?',
      student_response_text: 'A foreign session response on database indexes.',
      phase: 'fundamentals',
      start_ms: 0,
      end_ms: 30000
    }
  ])
};
