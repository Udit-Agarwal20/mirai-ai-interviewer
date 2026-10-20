"""In-memory usage preparation; no provider calls, identifiers, text, or file writes.

Values remain None until measured. Future adapters must add provider-reported
usage for every attempt, including failed/retried requests when billable usage is
reported. Do not use microphone-check time as STT usage or multiply it into cost.
"""

from dataclasses import dataclass, field
from math import isfinite

UNITS = {
    "stt_audio": "seconds",
    "llm_input": "tokens",
    "llm_output": "tokens",
    "tts_text": "characters",
    "tts_audio": "seconds",
    "livekit_participant": "seconds",
    "agent_session": "seconds",
    "retry": "requests",
    "failure": "requests",
    "cpu": "seconds",
    "memory": "byte_seconds",
    "storage": "byte_seconds",
    "egress": "bytes",
}


@dataclass
class UsageLedger:
    _totals: dict[str, dict[str, float]] = field(default_factory=dict, repr=False)

    def add(self, metric: str, quantity: float, *, source: str) -> None:
        if metric not in UNITS or source not in {"provider", "instrumented"}:
            raise ValueError("Unknown metric or measurement source")
        if isinstance(quantity, bool) or not isinstance(quantity, (int, float)) or not isfinite(quantity) or quantity < 0:
            raise ValueError("Usage must be a finite nonnegative quantity")
        if UNITS[metric] in {"tokens", "characters", "requests", "bytes"} and quantity != int(quantity):
            raise ValueError("This usage unit requires a whole number")
        bucket = self._totals.setdefault(metric, {})
        total = bucket.get(source, 0) + quantity
        if not isfinite(total):
            raise ValueError("Usage total overflow")
        bucket[source] = total

    def snapshot(self) -> dict:
        # Keep provider and local estimates separate; do not double-count them.
        return {
            "measured_usage": {
                metric: {"unit": unit, "by_source": dict(self._totals[metric]) if metric in self._totals else None}
                for metric, unit in UNITS.items()
            },
            "cost": None,
            "note": "Not a bill. Unmeasured usage and cost are unknown, not zero.",
        }

    def credit_estimate(self) -> dict:
        """Partial LLM estimate only, using published LiveKit list rates (2026-10-20).

        Cache discounts are deliberately not assumed. This is not a balance, bill,
        complete pipeline cost, or permission to spend. Missing usage stays unknown.
        """
        def provider(metric):
            return self._totals.get(metric, {}).get('provider')
        incoming, outgoing = provider('llm_input'), provider('llm_output')
        return {
            'currency':'USD', 'model':'google/gemini-3-flash-preview',
            'price_date':'2026-10-20',
            'llm_list_rate_estimate':None if incoming is None or outgoing is None else (incoming*.5+outgoing*3)/1_000_000,
            'total_pipeline_cost':None,
            'unknown_components':['stt_billed_usage','tts_billed_usage','transport','compute','storage','egress'],
            'note':'Uncached list-rate estimate from reported tokens; reconcile provider dashboards. No credit balance inferred.'
        }
