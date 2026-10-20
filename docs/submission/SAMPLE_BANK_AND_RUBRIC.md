# Sample bank and rubric

Canonical runnable sample: `poc/voice/lib/demo/model.ts` (`seed`, five HTTP-idempotency questions) and `poc/voice/lib/evaluation/contract.ts` (authoritative evaluator dimensions/ranges/weights). These are synthetic developer fixtures. They start draft; the faculty fixture must approve them before any interview. This is not institutional approval.

| Dimension | Weight | Score range |
|---|---:|---:|
| Conceptual understanding | 30% | 0–5 |
| Depth and reasoning | 25% | 0–5 |
| Problem solving | 20% | 0–5 |
| Practical / project knowledge | 15% | 0–5 |
| Communication | 10% | 0–5 |

Total = sum(score / 5 × weight); integer scores yield an exact integer total. Mock evaluation is explicitly labeled; real AI scoring accuracy remains untested. Review the runnable bank in `/demo`, approve v1, then inspect its provenance with the completed transcript.
