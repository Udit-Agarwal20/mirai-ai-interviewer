# MSOT pilot feasibility — executive decision brief

**Mirai AI Interviewer · 20 October 2026 · Prototype, not a deployed pilot**

## Decision in one paragraph

Mirai demonstrates a **tested offline faculty → student consent → adaptive synthetic viva → evidence-linked mock scoring → faculty override** workflow. Its real voice integration is experimental and not end-to-end verified; production recording, persistence, institutional login, human-calibrated scoring and 50/100/150-session load evidence are incomplete. A 350-student deployment is therefore a **conditional engineering plan**, **not an achieved capability**. The most useful near-term outcome is an authorized pilot that measures real usage, latency, fairness and quotas before institutional rollout.

## Numbers judges can evaluate

| Planning question | Answer and confidence |
|---|---|
| How many viva minutes? | 350 × 15 = **5,250 interview minutes (87.5 hours)** — arithmetic |
| How many slots at 150 concurrent? | **3 × 15 minutes = 45 minutes**, plus setup/recovery — arithmetic, not measured |
| How many slots at 100 concurrent? | **4 × 15 minutes = 60 minutes**, excluding overhead — arithmetic |
| Cost of 200/250/300/350 students? | Illustrative **₹10.6k / ₹13.2k / ₹15.9k / ₹18.5k** in a hosted-agent planning case — **not measured** |
| Cost per viva? | Illustrative **~₹53**, with ~₹34–₹75 usage sensitivity; excludes taxes and fixed fees |
| Can Mirai handle 150 today? | **No evidence.** Actual live PoC is restricted to one authorized session |
| Biggest external blocker? | LiveKit Inference public plans list **5/20/50 concurrent sessions**; 150 requires custom allowance or an approved alternative |
| Required proof? | Consented real recordings, scoring comparison, WER, p50/p95, WebRTC load tests, faculty playback and cost invoices |

## What is proven versus planned

**Proven locally (agent-reported, with published logs):** 64 frontend/browser tests, 28 Python tests, TypeScript/build passes, offline walkthrough, clock and evidence/override invariants. The data and evaluation are synthetic.

**Not proven:** 15-minute real voice, full audio retention/replay, faculty-vs-AI scoring accuracy, 20-clip WER, p95 speech latency, 150-session concurrency, rate-limit recovery and actual production cost.

## Suggested deployment progression

1. **G0: Offline demonstration** — complete, reproducible and clearly synthetic.
2. **G1: Consented voice pilot** — verify one full 15-minute voice viva with timestamped transcript, durable two-party recording, faculty replay and billable usage log.
3. **G2: Quality and fairness** — 5 recorded vivas, 3 personas, ≥10 human/AI scoring pairs, repeated scoring, ≥20 Indian English/Hinglish WER clips, latency and recovery tests.
4. **G3: Scale** — audio-bot tests at 50/100/150, measure p95 latency/errors/drops/CPU, find breaking point, obtain quota approvals and budget caps.
5. **G4: MSOT deployment** — institutional authentication, encrypted durable storage, retention/deletion agreement, support escalation and approved pricing.

**Submission evidence:** [Test Report](TEST_REPORT.md) · [Cost model](COST_SHEET.md) · [Capacity plan](CAPACITY_PLAN.md) · [Architecture](ARCHITECTURE.md) · [Privacy](PRIVACY_NOTE.md).

**Important:** The project should be judged on its demonstrated offline engineering and its transparent plan, **not** on unperformed real voice or scale tests.
