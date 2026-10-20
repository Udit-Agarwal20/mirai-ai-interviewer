import { test, expect } from '@playwright/test';
import {
  CRITERION_CODES,
  EvaluationError,
  EvaluationService,
  OFFICIAL_RUBRIC_CRITERIA,
  SyntheticMockEvaluatorAdapter,
  calculateTranscriptHash,
  computeCriterionContribution,
  computeWeightedTotal,
  evasiveTranscript,
  foreignSessionTranscript,
  offTopicTranscript,
  partialTranscript,
  silentTranscript,
  strongTranscript,
  unfinalizedTranscript,
  validateEvaluation,
  validateScoreValue,
  type CriterionCode,
  type EvaluatorAdapter,
  type EvaluatorProvenance,
  type FinalizedTranscript,
  type RawCriterionScore,
  type RawEvaluationOutput
} from '../lib/evaluation';

test.describe('TASK-022A/023A: Post-Viva Evaluation Contract and Evidence Validation', () => {
  const service = new EvaluationService();
  const mockAdapter = new SyntheticMockEvaluatorAdapter();

  // 1. Valid complete evaluation
  test('1. Valid complete evaluation passes validation and generates server-computed score', async () => {
    const result = await service.evaluateSession(strongTranscript, mockAdapter);

    expect(result.session_id).toBe(strongTranscript.session_id);
    expect(result.scores).toHaveLength(5);
    expect(result.ai_total).toBe(70); // [5,4,3,2,1]: 5*6 + 4*5 + 3*4 + 2*3 + 1*2 = 30 + 20 + 12 + 6 + 2 = 70
    expect(result.final_total).toBe(result.ai_total);
    expect(result.transcript_hash).toBe(strongTranscript.transcript_hash);
    expect(result.overrides).toHaveLength(0);

    for (const score of result.scores) {
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(5);
      expect(score.evidence.length).toBeGreaterThan(0);
      for (const ev of score.evidence) {
        expect(ev.turn_id).toMatch(/^turn-s[1-4]$/);
        expect(ev.matched_char_range[1]).toBeGreaterThan(ev.matched_char_range[0]);
      }
    }
  });

  // 2. Exact weighted arithmetic
  test('2. Exact weighted arithmetic matches official rubric weights with zero rounding error', () => {
    expect(OFFICIAL_RUBRIC_CRITERIA.map(c => [c.code, c.weightPercent])).toEqual([
      ['conceptual_understanding', 30],
      ['depth_and_reasoning', 25],
      ['problem_solving', 20],
      ['practical_knowledge', 15],
      ['communication', 10]
    ]);

    // Official benchmark from Master Specification Chapter 22:
    // Scores [5, 4, 3, 2, 1] in order -> exact 70.0
    const benchmarkScores: { code: CriterionCode; score: number }[] = [
      { code: 'conceptual_understanding', score: 5 }, // 5 * 6 = 30
      { code: 'depth_and_reasoning', score: 4 }, // 4 * 5 = 20
      { code: 'problem_solving', score: 3 }, // 3 * 4 = 12
      { code: 'practical_knowledge', score: 2 }, // 2 * 3 = 6
      { code: 'communication', score: 1 } // 1 * 2 = 2 -> Total = 70
    ];
    expect(computeWeightedTotal(benchmarkScores)).toBe(70);

    // Minimum: all 0s -> 0
    expect(
      computeWeightedTotal(CRITERION_CODES.map(code => ({ code, score: 0 })))
    ).toBe(0);

    // Maximum: all 5s -> 100
    expect(
      computeWeightedTotal(CRITERION_CODES.map(code => ({ code, score: 5 })))
    ).toBe(100);

    // Realistic mixed: [4, 3, 4, 5, 4] -> 4*6 + 3*5 + 4*4 + 5*3 + 4*2 = 24 + 15 + 16 + 15 + 8 = 78
    const mixed = [
      { code: 'conceptual_understanding' as const, score: 4 },
      { code: 'depth_and_reasoning' as const, score: 3 },
      { code: 'problem_solving' as const, score: 4 },
      { code: 'practical_knowledge' as const, score: 5 },
      { code: 'communication' as const, score: 4 }
    ];
    expect(computeWeightedTotal(mixed)).toBe(78);

    // Individual contributions
    expect(computeCriterionContribution('conceptual_understanding', 5)).toBe(30);
    expect(computeCriterionContribution('depth_and_reasoning', 4)).toBe(20);
    expect(computeCriterionContribution('problem_solving', 3)).toBe(12);
    expect(computeCriterionContribution('practical_knowledge', 2)).toBe(6);
    expect(computeCriterionContribution('communication', 1)).toBe(2);

    // Disregards claimed total in model response
    const rawWithClaimedTotal: RawEvaluationOutput = {
      scores: benchmarkScores.map(s => ({
        criterion_code: s.code,
        score: s.score,
        rationale: 'Valid rationale with sufficient characters',
        evidence: [{ turn_id: 'turn-s1', verbatim_quote: 'intended effect' }]
      })),
      feedback_lines: ['Good work.'],
      claimed_total: 999 // Model hallucinated or claimed 999
    };
    const validated = validateEvaluation(strongTranscript, rawWithClaimedTotal, mockAdapter.provenance);
    expect(validated.ai_total).toBe(70); // Server-computed, not 999
  });

  // 3. Invalid score values
  test('3. Invalid score values (negative, >5, decimal, NaN, non-integer) are rejected', () => {
    for (const bad of [-1, 6, 2.5, NaN, Infinity, -0.1, 5.1]) {
      expect(() => validateScoreValue(bad)).toThrow(EvaluationError);
      expect(() =>
        computeWeightedTotal([
          { code: 'conceptual_understanding', score: bad as number },
          { code: 'depth_and_reasoning', score: 3 },
          { code: 'problem_solving', score: 3 },
          { code: 'practical_knowledge', score: 3 },
          { code: 'communication', score: 3 }
        ])
      ).toThrow();
    }
  });

  // 4. Missing criterion
  test('4. Missing criterion triggers MISSING_CRITERION error and fails evaluation', () => {
    // Only 4 criteria supplied (missing 'communication')
    const partialScores: RawCriterionScore[] = [
      {
        criterion_code: 'conceptual_understanding',
        score: 4,
        rationale: 'Solid conceptual understanding.',
        evidence: [{ turn_id: 'turn-s1', verbatim_quote: 'intended effect' }]
      },
      {
        criterion_code: 'depth_and_reasoning',
        score: 3,
        rationale: 'Good depth.',
        evidence: [{ turn_id: 'turn-s2', verbatim_quote: 'unique key' }]
      },
      {
        criterion_code: 'problem_solving',
        score: 3,
        rationale: 'Good problem solving.',
        evidence: [{ turn_id: 'turn-s4', verbatim_quote: 'simulate a timeout' }]
      },
      {
        criterion_code: 'practical_knowledge',
        score: 3,
        rationale: 'Good practical knowledge.',
        evidence: [{ turn_id: 'turn-s4', verbatim_quote: 'test conflicting payloads' }]
      }
    ];

    const result = validateEvaluation(
      strongTranscript,
      { scores: partialScores, feedback_lines: [] },
      mockAdapter.provenance
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'MISSING_CRITERION' && i.criterion_code === 'communication')).toBe(true);
  });

  // 5. Duplicate criterion
  test('5. Duplicate criterion entries are detected and rejected', () => {
    const duplicateScores: RawCriterionScore[] = [
      {
        criterion_code: 'conceptual_understanding',
        score: 4,
        rationale: 'First entry.',
        evidence: [{ turn_id: 'turn-s1', verbatim_quote: 'intended effect' }]
      },
      {
        criterion_code: 'conceptual_understanding', // Duplicate!
        score: 5,
        rationale: 'Conflicting second entry.',
        evidence: [{ turn_id: 'turn-s1', verbatim_quote: 'intended effect' }]
      },
      {
        criterion_code: 'depth_and_reasoning',
        score: 3,
        rationale: 'Depth rationale.',
        evidence: [{ turn_id: 'turn-s2', verbatim_quote: 'unique key' }]
      },
      {
        criterion_code: 'problem_solving',
        score: 3,
        rationale: 'Problem solving rationale.',
        evidence: [{ turn_id: 'turn-s4', verbatim_quote: 'simulate a timeout' }]
      },
      {
        criterion_code: 'practical_knowledge',
        score: 3,
        rationale: 'Practical rationale.',
        evidence: [{ turn_id: 'turn-s4', verbatim_quote: 'test conflicting payloads' }]
      }
    ];

    const result = validateEvaluation(
      strongTranscript,
      { scores: duplicateScores, feedback_lines: [] },
      mockAdapter.provenance
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'DUPLICATE_CRITERION' && i.criterion_code === 'conceptual_understanding')).toBe(true);
  });

  // 6. Hallucinated citation
  test('6. Hallucinated citation (quoted string not in student response) is caught and rejected', () => {
    const hallucinatedScores: RawCriterionScore[] = CRITERION_CODES.map(code => ({
      criterion_code: code,
      score: 4,
      rationale: 'Rationale for candidate performance.',
      evidence: [
        {
          turn_id: 'turn-s1',
          // Student never said this phrase!
          verbatim_quote: 'I used a distributed Redis cluster with raft consensus protocol'
        }
      ]
    }));

    const result = validateEvaluation(
      strongTranscript,
      { scores: hallucinatedScores, feedback_lines: [] },
      mockAdapter.provenance
    );

    expect(result.valid).toBe(false);
    const hallucinationIssues = result.issues.filter(i => i.code === 'HALLUCINATED_EVIDENCE');
    expect(hallucinationIssues.length).toBeGreaterThan(0);
    expect(hallucinationIssues[0].message).toContain('does not match verbatim');
  });

  // 7. Wrong-session citation
  test('7. Evidence citation from a different session transcript is rejected as cross-session citation', () => {
    const wrongSessionScores: RawCriterionScore[] = CRITERION_CODES.map(code => ({
      criterion_code: code,
      score: 4,
      rationale: 'Rationale referencing another student.',
      evidence: [
        {
          // Belongs to foreignSessionTranscript, NOT strongTranscript!
          turn_id: 'turn-foreign-1',
          verbatim_quote: 'A foreign session response on database indexes.'
        }
      ]
    }));

    const result = validateEvaluation(
      strongTranscript,
      { scores: wrongSessionScores, feedback_lines: [] },
      mockAdapter.provenance
    );

    expect(result.valid).toBe(false);
    const wrongTurnIssues = result.issues.filter(i => i.code === 'NONEXISTENT_TURN');
    expect(wrongTurnIssues.length).toBeGreaterThan(0);
    expect(wrongTurnIssues[0].turn_id).toBe('turn-foreign-1');
  });

  // 8. Interviewer-only quotation
  test('8. Citation referencing words spoken only by the interviewer is detected and rejected', () => {
    const interviewerQuoteScores: RawCriterionScore[] = CRITERION_CODES.map(code => ({
      criterion_code: code,
      score: 3,
      rationale: 'Candidate addressed the topic.',
      evidence: [
        {
          turn_id: 'turn-s1',
          // This question prompt was spoken by the interviewer, NOT the student!
          verbatim_quote: 'What does idempotency mean for an HTTP API?'
        }
      ]
    }));

    const result = validateEvaluation(
      strongTranscript,
      { scores: interviewerQuoteScores, feedback_lines: [] },
      mockAdapter.provenance
    );

    expect(result.valid).toBe(false);
    const promptIssues = result.issues.filter(i => i.code === 'INTERVIEWER_TEXT_CITED');
    expect(promptIssues.length).toBeGreaterThan(0);
    expect(promptIssues[0].message).toContain("cites the interviewer's prompt instead of candidate speech");
  });

  // 9. Insufficient student evidence
  test('9. Insufficient student evidence (very short answers or evasive response) flags review_required', async () => {
    const result = await service.evaluateSession(evasiveTranscript, mockAdapter);

    expect(result.status).toBe('review_required');
    expect(result.review_reasons.some(r => r.includes('Very short interview responses'))).toBe(true);
  });

  // 10. Empty transcript
  test('10. Empty transcript (0 turns or silent candidate) cannot be evaluated and fails safely', async () => {
    await expect(service.evaluateSession(silentTranscript, mockAdapter)).rejects.toThrow(
      EvaluationError
    );

    const emptyValidation = validateEvaluation(
      silentTranscript,
      {
        scores: CRITERION_CODES.map(c => ({
          criterion_code: c,
          score: 0,
          rationale: 'Empty transcript test.',
          evidence: []
        })),
        feedback_lines: []
      },
      mockAdapter.provenance
    );

    expect(emptyValidation.valid).toBe(false);
    expect(emptyValidation.issues.some(i => i.code === 'EMPTY_TRANSCRIPT')).toBe(true);
  });

  // 11. Unfinalized session
  test('11. Unfinalized session (status !== completed) is rejected from evaluation queue', async () => {
    await expect(service.evaluateSession(unfinalizedTranscript, mockAdapter)).rejects.toThrow(
      EvaluationError
    );

    const unfinalizedValidation = validateEvaluation(
      unfinalizedTranscript,
      {
        scores: CRITERION_CODES.map(c => ({
          criterion_code: c,
          score: 3,
          rationale: 'Active session test.',
          evidence: [{ turn_id: 'turn-s1', verbatim_quote: 'intended effect' }]
        })),
        feedback_lines: []
      },
      mockAdapter.provenance
    );

    expect(unfinalizedValidation.valid).toBe(false);
    expect(unfinalizedValidation.issues.some(i => i.code === 'UNFINALIZED_SESSION')).toBe(true);
  });

  // 12. Malformed model output
  test('12. Malformed model output (non-object, missing scores, non-array) fails gracefully', () => {
    // Non-object
    const res1 = validateEvaluation(strongTranscript, null as unknown as RawEvaluationOutput, mockAdapter.provenance);
    expect(res1.valid).toBe(false);
    expect(res1.issues.some(i => i.code === 'MALFORMED_PAYLOAD')).toBe(true);

    // Scores not array
    const res2 = validateEvaluation(
      strongTranscript,
      { scores: 'invalid' as unknown as RawCriterionScore[], feedback_lines: [] },
      mockAdapter.provenance
    );
    expect(res2.valid).toBe(false);
    expect(res2.issues.some(i => i.code === 'MALFORMED_PAYLOAD')).toBe(true);

    // Malformed rationale (<10 chars)
    const shortRationaleScores: RawCriterionScore[] = CRITERION_CODES.map(code => ({
      criterion_code: code,
      score: 3,
      rationale: 'short', // Under 10 chars
      evidence: [{ turn_id: 'turn-s1', verbatim_quote: 'intended effect' }]
    }));
    const res3 = validateEvaluation(
      strongTranscript,
      { scores: shortRationaleScores, feedback_lines: [] },
      mockAdapter.provenance
    );
    expect(res3.valid).toBe(false);
    expect(res3.issues.some(i => i.code === 'MALFORMED_RATIONALE')).toBe(true);
  });

  // 13. Duplicate evaluation submission / hash verification
  test('13. Transcript hash verification prevents evaluations on mutated or mismatched transcripts', async () => {
    // Tamper with transcript hash
    const tamperedTranscript: FinalizedTranscript = {
      ...strongTranscript,
      transcript_hash: 'tampered-sha256-hash-value-that-does-not-match-turns'
    };

    await expect(service.evaluateSession(tamperedTranscript, mockAdapter)).rejects.toThrow(
      EvaluationError
    );
  });

  // 14. Immutable original result
  test('14. Original AI score and ai_total remain strictly immutable after faculty override', async () => {
    const originalEval = await service.evaluateSession(strongTranscript, mockAdapter);
    const originalAiTotal = originalEval.ai_total;
    const originalScores = originalEval.scores.map(s => ({ code: s.criterion_code, score: s.score }));

    // Apply override to conceptual understanding
    const overridden = service.applyOverride(originalEval, {
      criterion_code: 'conceptual_understanding',
      new_score: 3, // Overriding from 5 to 3
      reason: 'Faculty adjusted score based on rubric clarity standards.',
      reviewer_id: 'faculty-evaluator-1'
    });

    // Original evaluation properties remain identical
    expect(overridden.ai_total).toBe(originalAiTotal);
    expect(overridden.scores.map(s => ({ code: s.criterion_code, score: s.score }))).toEqual(
      originalScores
    );

    // Effective score and final total are updated
    const conceptual = overridden.scores.find(s => s.criterion_code === 'conceptual_understanding')!;
    expect(conceptual.score).toBe(5); // Original AI score preserved!
    expect(conceptual.effective_score).toBe(3); // Faculty effective score
    expect(overridden.final_total).not.toBe(originalAiTotal);
    expect(overridden.final_total).toBe(originalAiTotal! - 12); // 5*6=30 -> 3*6=18, delta -12
  });

  // 15. Faculty override preservation
  test('15. Faculty overrides are stored in append-only history with full audit metadata', async () => {
    const evaluation = await service.evaluateSession(strongTranscript, mockAdapter);

    // Override 1
    const over1 = service.applyOverride(evaluation, {
      criterion_code: 'depth_and_reasoning',
      new_score: 3,
      reason: 'First faculty review adjustment.',
      reviewer_id: 'faculty-1'
    });

    // Override 2 on same criterion
    const over2 = service.applyOverride(over1, {
      criterion_code: 'depth_and_reasoning',
      new_score: 2,
      reason: 'Second review after re-listening to turn 2.',
      reviewer_id: 'faculty-lead'
    });

    expect(over2.overrides).toHaveLength(2);
    expect(over2.overrides[0].old_score).toBe(4);
    expect(over2.overrides[0].new_score).toBe(3);
    expect(over2.overrides[0].reviewer_id).toBe('faculty-1');

    expect(over2.overrides[1].old_score).toBe(3);
    expect(over2.overrides[1].new_score).toBe(2);
    expect(over2.overrides[1].reviewer_id).toBe('faculty-lead');

    // Reject overrides with insufficient reason (<10 chars)
    expect(() =>
      service.applyOverride(evaluation, {
        criterion_code: 'communication',
        new_score: 2,
        reason: 'too short',
        reviewer_id: 'faculty-1'
      })
    ).toThrow(EvaluationError);
  });

  // 16. Student role isolation
  test('16. Student view projection completely redacts evaluation details, raw scores, and rationale', async () => {
    const evaluation = await service.evaluateSession(strongTranscript, mockAdapter);
    const studentView = service.toStudentView(evaluation);

    expect(studentView).toEqual({
      evaluated: true,
      status: 'pending_faculty_release'
    });
    expect(studentView).not.toHaveProperty('scores');
    expect(studentView).not.toHaveProperty('ai_total');
    expect(studentView).not.toHaveProperty('final_total');
    expect(studentView).not.toHaveProperty('feedback_lines');
    expect(studentView).not.toHaveProperty('review_reasons');
  });

  // 17. Review-required status
  test('17. Review-required status is triggered for off-topic, evasive, or low-evidence sessions', async () => {
    // Off-topic viva
    const offTopicEval = await service.evaluateSession(offTopicTranscript, mockAdapter);
    expect(offTopicEval.status).toBe('review_required');
    expect(offTopicEval.ai_total).toBe(2); // Only communication scored 1 -> 1*2 = 2

    // Evasive viva
    const evasiveEval = await service.evaluateSession(evasiveTranscript, mockAdapter);
    expect(evasiveEval.status).toBe('review_required');

    // Overridden evaluation transitions to review_required
    const normalEval = await service.evaluateSession(strongTranscript, mockAdapter);
    const overridden = service.applyOverride(normalEval, {
      criterion_code: 'communication',
      new_score: 3,
      reason: 'Audit review of tone and pacing in responses.',
      reviewer_id: 'faculty-reviewer'
    });
    expect(overridden.status).toBe('review_required');
  });

  // 18. Synthetic provenance labeling
  test('18. Synthetic mock evaluator is explicitly flagged as synthetic and disclaimed', async () => {
    const evaluation = await service.evaluateSession(strongTranscript, mockAdapter);

    expect(evaluation.provenance.is_synthetic).toBe(true);
    expect(evaluation.provenance.kind).toBe('synthetic_mock');
    expect(evaluation.provenance.notice).toContain('Deterministic offline fixture evaluator');
    expect(evaluation.review_reasons.some(r => r.includes('Synthetic test mock provenance'))).toBe(true);
  });
});
