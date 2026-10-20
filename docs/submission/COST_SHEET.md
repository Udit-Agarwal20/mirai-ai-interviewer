# MSOT pilot cost model — scenario estimate, not a measured bill

**Prepared 20 October 2026 · Currency: INR (₹) · Status: planning estimate only.** This document is a **transparent, reproducible model**, not a price quotation, account bill, production benchmark or proof of readiness. The Mirai offline demonstration does **not** call paid providers; the separate voice pipeline has not been end-to-end verified. **Actual spend for the proposed 350-viva pilot is unknown.**

## Executive answer

Under one **illustrative hosted-agent/API scenario**, the planning case is **about ₹53 per 15-minute viva**, or **about ₹18,550 for 350 students**, *before taxes, fixed subscription commitments, additional infrastructure, institutional operations and faculty review*. A lean usage case is ~₹34/viva; a higher-usage stress case is ~₹75/viva. These are **model outputs, not measured costs**. Do not describe them as what Mirai currently costs to operate.

| Students (15 min each) | Lean scenario | Planning scenario | Stress scenario |
|---:|---:|---:|---:|
| 200 | ₹6,746 | ₹10,598 | ₹15,060 |
| 250 | ₹8,433 | ₹13,248 | ₹18,825 |
| 300 | ₹10,119 | ₹15,898 | ₹22,590 |
| 350 | ₹11,806 | ₹18,547 | ₹26,355 |

Figures are rounded to the nearest rupee from the unrounded per-viva model; **not a supplier quote**. Costs scale linearly with cohort size in this model, but real plans, quotas, burst capacity, staffing, taxes and reserved infrastructure can make actual total cost nonlinear.

## Public reference prices and modeling inputs

| Component | Public reference price | Planning assumption | Modeled cost/viva |
|---|---|---|---:|
| Deepgram Nova-3 multilingual **streaming STT** | $0.0058/min promotional; **$0.0092/min regular** | 15 billed minutes × regular rate | ₹12.42 |
| Sarvam Bulbul v3 **TTS** | **₹30 / 10,000 characters** | 5,000 generated characters | ₹15.00 |
| Gemini 3 Flash via LiveKit Inference | **$0.50 / 1M input tokens**, **$3.00 / 1M output tokens** | 30,000 input + 3,000 output tokens, interviewer + scorer combined | ₹2.16 |
| LiveKit Cloud **hosted-agent session** | **$0.01/min** shown in LiveKit's agent pricing calculator | 15 hosted agent minutes | ₹13.50 |
| Recording, storage and egress | **No validated account quote** | Placeholder allowance | ₹3.00 |
| **Subtotal** | | | **₹46.08** |
| Reliability/retry contingency | **Modeling assumption, not a tariff** | 15% of subtotal | **₹6.91** |
| **Planning total per viva** | | | **₹52.99 ≈ ₹53** |

**FX assumption:** $1 = ₹90 is a **round planning conversion**, not a live foreign-exchange quotation. The Deepgram planning rate deliberately uses the **regular**, not promotional, rate. The model assumes one 15-minute student audio stream; separate streams, duplicated audio, reconnections or different provider billing can increase cost. TTS characters and token counts are hypotheses until real usage logs are captured.

**Hosting topology warning:** The current prototype runs a **local Python agent**, not a verified LiveKit Cloud-hosted agent. The $0.01/min hosted-agent line is a *what-if deployment scenario* and **must be replaced by measured self-hosted compute cost** if using a self-hosted agent. Do not charge both the hosted-agent fee and the same self-hosted worker compute. LiveKit transport, observability, recording, object storage, networking, and plan minima require separate confirmation. The selected `google/gemini-3-flash-preview` identifier must be mapped to the actually billable SKU; pricing above references the public Gemini 3 Flash listing, not a verified preview-SKU invoice. A stronger separate scorer would need its own model/tokens line.

### Sources (verify account-specific prices and eligibility before a pilot)

- [Deepgram pricing](https://deepgram.com/pricing) — Nova-3 multilingual streaming rate and promotional/regular distinction.
- [Sarvam pricing documentation](https://docs.sarvam.ai/api/getting-started/pricing) — Bulbul v3 ₹30 per 10K characters.
- [LiveKit Inference pricing](https://livekit.com/pricing/inference) — Gemini 3 Flash token prices and concurrency tiers.
- [LiveKit agent pricing calculator](https://livekit.com/pricing) — illustrative Cloud-hosted agent session price; not necessarily applicable to self-hosted agents.

## Scenario sensitivity (per 15-minute viva)

| Variable | Lean | Planning | Stress |
|---|---:|---:|---:|
| STT billed minutes / rate | 10 / $0.0058 | 15 / $0.0092 | 15 / $0.0092 |
| Generated TTS characters | 3,000 | 5,000 | 8,000 |
| Gemini input tokens | 15,000 | 30,000 | 60,000 |
| Gemini output tokens | 1,000 | 3,000 | 6,000 |
| Hosted-agent minutes | 15 | 15 | 15 |
| Recording/storage/egress allowance | ₹2 | ₹3 | ₹6 |
| Contingency | 10% | 15% | 25% |
| **Modeled total per viva** | **₹33.73** | **₹52.99** | **₹75.30** |

**Reproduce any scenario:**

```text
STT_INR = billed_STT_minutes × STT_USD_per_min × FX_INR_per_USD
TTS_INR = TTS_characters / 10,000 × 30
LLM_INR = (input_tokens / 1,000,000 × 0.50
           + output_tokens / 1,000,000 × 3.00) × FX_INR_per_USD
HOSTED_AGENT_INR = hosted_agent_minutes × 0.01 × FX_INR_per_USD
VARIABLE_PER_VIVA = (STT_INR + TTS_INR + LLM_INR
                     + HOSTED_AGENT_INR + storage_and_egress_INR)
                     × (1 + contingency_rate)
COHORT_VARIABLE = student_count × VARIABLE_PER_VIVA
TOTAL_PILOT = COHORT_VARIABLE + fixed_plan_fees + reserved_capacity
              + extra_networking + tax + operations + faculty_review
```

These equations are *not* a substitute for actual metered consumption, tax treatment or a provider quotation. Do not subtract promotional credits when reporting sustainable cost per viva; disclose credits separately if used.

## Hosted APIs versus self-hosting

| Choice | Potential advantage | Material risk / unmeasured cost |
|---|---|---|
| Managed APIs + hosted agents | Faster integration, elastic services where quota allows | Concurrency approvals, per-minute/tokens/characters charges, plan minima, third-party data handling |
| Managed APIs + self-hosted agents | Control over worker deployment | Worker CPU/RAM/network, autoscaling, on-call operations; **replace**, do not duplicate, hosted-agent line |
| Self-hosted STT/TTS/LLM | Lower marginal API spend *may* be possible at sustained utilization | GPU purchase/rental, deployment, capacity redundancy, speech quality and latency validation, maintenance |

For a one-off cohort of 350, self-hosting is **not automatically cheaper**: total ownership cost depends on hardware availability, utilization and engineering support. No measured GPU sizing or hourly price is available for a defensible numeric comparison.

## Before claiming pilot feasibility or a final budget

1. Capture one **authorized, consented** 15-minute voice session and meter STT seconds, LLM input/output tokens, TTS characters, agent minutes, recordings and network egress. The current 120-second gated PoC is not that session.
2. Verify **provider-specific** model availability, prices, account quotas, 150-session burst allowance, rate limits and any minimum monthly commitment; do not enable spending without explicit approval.
3. Confirm whether the deployment is LiveKit Cloud-hosted or self-hosted, then replace the appropriate worker cost line.
4. Test real audio at 50/100/150 concurrency and record p50/p95 speech latency, errors, drops, resource usage and breaking point; the official target is p95 under 2.5 seconds.
5. Get institution-approved recording retention, access control and deletion rules; price **both sides of the conversation**, if required, and storage for the required retention period.
6. Recalculate with actual invoice usage and provider FX/taxes; obtain written capacity approval before a 350-student pilot.

**Status:** no live cost measurement, no account-balance verification and no authorized production budget. No provider calls were made to produce this document.
