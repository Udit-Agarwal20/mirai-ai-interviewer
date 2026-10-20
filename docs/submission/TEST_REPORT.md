# Mirai AI Interviewer — mandatory Test Report

## Scope and truth labels

Publication verification uses the sanitized source snapshot in this fresh public repository. Original challenge and planning documents are not redistributed. This report covers a local synthetic workflow, structural checks and mocked provider tests. **It does not establish hackathon qualification. Mandatory real evidence remains incomplete.**

## Executed verification

| Check | Result | Raw output |
|---|---|---|
| `npm test` in `poc/voice` | 64 passed, no failed tests | [frontend](results/frontend.txt) |
| `npm run typecheck` | PASS | [typecheck](results/typecheck.txt) |
| `npm run build` | PASS, production compilation | [build](results/build.txt) |
| `.venv/bin/python -m unittest -v` in `poc/voice/agent` | 28 passed | [Python](results/python.txt) |
| `git diff --check` | PASS | terminal check |
| Credential-value comparison against tracked/new source and 11 browser bundles | No matches; no credential values emitted | local security check |
| Ignore rules: `.env.local`, `.next`, `.venv`, `.playwright-mcp` | All ignored | `git check-ignore` |

The first publication build attempt rejected an external node_modules symlink. Copying the already-installed dependencies into the temporary checkout resolved it; no application changes or network installs were needed. All reported checks then passed in the sanitized checkout without an environment file. Build-output trailing whitespace was normalized for Git; result content is unchanged. Screenshots in `docs/assets/screenshots/` come from this run.

The frontend suite includes domain tests, real local HTTP/browser interactions and mocked voice lifecycle tests. It is **not 64 real voice interviews**. Python tests use synthetic providers/offline SDK construction. Playwright starts only the unarmed loopback Python supervisor, without `--allow-live`; no real agent session or room is created.

## New deadline regression coverage

`poc/voice/tests/demo-clock.spec.ts`: official phase boundaries and accelerated scaling; expiry without client activity; deadline checks before mutations; late-response rejection; evaluation/finalization once; evidence digest stability; empty transcript without invented marks; refresh/clock rollback protection; workspace isolation. An injectable clock exercises boundaries without waiting 15 minutes.

Standard offline target: 900 seconds total, input closes at 870 seconds for the official scoring window. Accelerated demo: 120 seconds total, input closes at 116 seconds. Server scheduler runs every 250ms; UI polls every second. Requests check deadlines synchronously even between scheduler ticks. Process crashes still lose ephemeral state. A stalled event loop delays visible closure but cannot admit a late response once processed. The small approved question pool/five-turn limit may finish earlier; this is not proof of a complete 15-minute voice exam or phase-specific question coverage.

## End-to-end browser evidence

`tests/demo.spec.ts` and `tests/walkthrough.spec.ts` execute faculty approval → student consent → synthetic answers → transcript → existing evidence-grounded mock evaluation → faculty reasoned override. Walkthrough verifies original 70/100 preserved and effective total changed to 64/100, evaluator provenance, transcript digest and visible clock. Screenshots are generated in ignored `poc/voice/test-results/`; human should capture the final video. Another browser test blocks non-loopback requests and asserts no microphone use in the demo.

Existing tests cover consent, denied access, malformed IDs, duplicate commands, cross-workspace isolation, invalid override values/reasons, completed-session immutability, bad evidence/quotes, evaluator failure recovery, live approval denial and cancellation. Mocked errors are not proof of real provider reliability or fairness.

## Official minimum evidence status

| Required evidence (§7–8) | Actual status |
|---|---|
| Five full recorded 15-minute vivas with transcript and scores | INCOMPLETE: no real recordings |
| Three adaptive personas with real-model transcripts | INCOMPLETE: selectable synthetic scenarios only |
| ≥10 human/AI comparisons; average gap and correlation | NOT TESTED |
| Five real scoring repeats/transcript; variance | NOT TESTED; deterministic mock tests are not this evidence |
| WER on ≥20 Indian-English/Hinglish clips | NOT TESTED |
| p50/p95 speech latency, p95 <2.5s | NOT TESTED; scripted offsets are not latency |
| Real noise, silence, disconnect/rejoin robustness | NOT TESTED; local failure mocks only |
| Real-model prompt injection/accent fairness | NOT TESTED; bounded fixture/validation tests only |
| Faculty audio replay plus score trace | PARTIAL: text evidence/override verified, audio absent |
| 50/100/150 concurrency, errors, drops, CPU/memory | NOT TESTED |
| Breaking point and account quotas | UNKNOWN |
| Measured cost/viva and 350 students | UNKNOWN; formula-only cost sheet |

## Reproduce

From repository root (installed dependencies required):

```bash
cd poc/voice
npm run typecheck
npm run build
npm test
cd agent
.venv/bin/python -m unittest -v
```

Do not run a separate server on ports 3000/8001 during Playwright. Fresh frontend setup requires `npm ci` with registry access. Python tests require the existing pinned environment/uv lock described in the application README. These installations were not performed in this sprint.

Manual demo: `MIRAI_OFFLINE_DEMO=1 npm run dev` in `poc/voice`, open `http://127.0.0.1:3000/demo`. No credentials or Python process needed for that demo. Use synthetic data only. No provider requests, billing changes or paid expenditure occurred during this sprint. Live account balances/entitlements remain unverified. TASK-003 remains incomplete.
