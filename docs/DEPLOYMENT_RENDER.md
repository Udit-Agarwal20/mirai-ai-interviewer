# Render deployment — synthetic demonstration only

This deployment is **not** a production viva service. It has no real voice, no institutional authentication, no durable recording, and no persistent database. Never enter real student data. Do not enable paid voice providers.

## Before deploying

- Work only on the `deploy-demo` branch, never the submitted `main` branch.
- Render: Web Service; Node; root `poc/voice`; branch `deploy-demo`; free tier if available.
- Build command: `npm ci && npm run build`
- Start command: `npx next start --hostname 0.0.0.0 --port $PORT`
- Environment variables:
  - `MIRAI_OFFLINE_DEMO` = `1`
  - `MIRAI_PUBLIC_DEMO_ORIGIN` = **exact HTTPS origin** assigned by Render, e.g. `https://mirai-ai-interviewer.onrender.com` (verify the actual URL; do not include `/demo` or a trailing path)
- Leave all `LIVEKIT_*`, `DEEPGRAM_*`, `SARVAM_*`, `POC_LIVE_APPROVAL`, and other live-provider settings absent.
- Disable auto-deploy if you want full manual control of post-submission changes.

## Test

1. Open `<Render HTTPS URL>/demo`.
2. Create a synthetic workspace, approve bank, run accelerated interview, open faculty review, and test a reasoned override.
3. Verify the banner states synthetic/offline; no microphone or real voice should be used.
4. Check Render logs if any request fails. A 404 on demo API usually means the public origin variable does not match the deployed hostname.

## Limits

The in-memory workspace is local to one Node process and is lost on restart or free-tier spin-down. At most 40 workspaces are held. This is a public synthetic demonstration, **not a secure multi-tenant student platform**. The role fixtures are deliberately accessible to the demo user. Do not advertise it as a real exam, accept personal data, or use it for a large cohort. The public service may be abused or temporarily unavailable; turn it off if so.
