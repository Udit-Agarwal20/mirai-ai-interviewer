# Mirai application runbook

See the [root README](../../README.md) for the offline product walkthrough and verified status.

## Offline application

Node >=20.9 and npm are required. Install from the committed lockfile with `npm ci`, then:

```bash
MIRAI_OFFLINE_DEMO=1 npm run dev
```

Open http://127.0.0.1:3000/demo. No provider credentials or Python process is required. The server binds to loopback. Offline data is synthetic and ephemeral; restart clears it. Default mode is disabled unless the flag is set.

## Verification

```bash
npm run typecheck
npm run build
npm test
```

Full tests require Chromium and a Python 3.12 environment. With uv installed:

```bash
cd agent
uv sync --frozen
.venv/bin/python -m unittest -v
cd ..
npx playwright install chromium
npm test
```

Fresh dependency/browser installation uses network downloads. Tests themselves use local/mocked providers. The Playwright config starts an **unarmed** Python supervisor on 127.0.0.1:8001 and the production Next server on 127.0.0.1:3000. Leave these ports free. The automated supervisor path is POSIX-specific; use macOS/Linux/WSL for the full suite.

## Experimental voice boundary

Browser microphone → LiveKit WebRTC → local Python Agent → direct Deepgram `nova-3` → `google/gemini-3-flash-preview` through LiveKit Inference → Sarvam `bulbul:v3` (`shubh`) → browser playback.

This has not been verified through a live provider-backed session. Do not treat successful mocks or SDK construction as real voice evidence. There is no direct OpenAI billing path; Sarvam's SDK has an OpenAI-compatible transitive dependency.

The `.env.example` is safe and contains no credentials. Actual values belong only in an ignored local `.env.local`. The Python checker does not automatically load that file. To check configuration offline using uv, after local setup:

```bash
cd agent
uv run --frozen --offline --no-sync --env-file ../.env.local python main.py --check
```

This validates local configuration, not provider account access, credit balances or retention policies. Never share keys in chat, screenshots, logs or issues.

Live activation requires separate explicit human approval, account allowance/entitlement checks and billing controls consistent with ₹0 spending. Approval variables remain blank by default. The future live command uses `main.py --serve --allow-live`, but **must not be run without that approval**. The unarmed supervisor alone does not connect to providers.

Limits: one authorized session, at most 120 seconds and five student turns, default 128 output tokens (current validator permits 32–256), zero automatic provider retries, scoped short-lived room tokens, consent/preflight, and cleanup on failures. No recording or transcript persistence is enabled in the live PoC. Offline 15-minute clock options never change these limits.

## Offline clock and evaluation

The monotonic server clock closes input at 14:30 of a 15-minute target or 116 seconds of a two-minute accelerated demonstration. Reads, commands and a 250ms scheduler enforce expiry; browser polling is presentation only. Short fixture paths can finish earlier. Process failure loses the workspace.

The existing finalizer seals ordered turns and a digest. A synthetic evaluator passes through evidence validation before faculty review. This does not validate real AI grading. See the [Test Report](../../docs/submission/TEST_REPORT.md) and [privacy note](../../docs/submission/PRIVACY_NOTE.md).
