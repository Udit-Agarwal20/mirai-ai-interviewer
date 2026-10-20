# Capacity plan — proposed, not measured

Official requirement: 50/100/150 concurrent synthetic-audio clients, p95 response latency, provider error rates, drops, CPU/memory and breaking point. **NOT TESTED at every level.** No 150-session capacity claim.

Current offline adapter: one local process, at most 40 workspaces, ephemeral state. Current live PoC: one authorized session. Neither is a production capacity demonstration.

Before load testing: approve durable session storage, per-session agent isolation, provider account quotas, worker concurrency, admission control and queue policy; obtain explicit budget authorization. Measure WebRTC bots against real voice integrations, not repeated HTTP fixture requests. Test 50, then 100, then 150, stopping on agreed error/latency limits. Preserve raw results and record the first failing resource. Provider failures currently fail closed without automatic retries or provider substitution; production rate-limit strategy remains undecided.
