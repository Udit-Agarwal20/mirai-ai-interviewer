"""Local tests only; all network connection attempts fail immediately."""

import json
import socket
import unittest
from unittest.mock import patch

from config import REQUIREMENTS, readiness, require_live_access, ConfigError
from main import build_agent
from usage import UsageLedger


class FoundationTests(unittest.TestCase):
    def setUp(self):
        self.network = patch.object(socket.socket, "connect", side_effect=AssertionError("Network prohibited in local tests"))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.connection = patch("socket.create_connection", side_effect=AssertionError("Network prohibited"))
        self.connection.start()
        self.addCleanup(self.connection.stop)

    def test_missing_credentials_explain_names(self):
        report = readiness({})
        self.assertEqual(sum(len(p["missing"]) for p in report["providers"]), 7)
        self.assertFalse(report["live_connections_enabled"])

    def test_credentials_never_enable_calls_or_leak_values(self):
        fake = {key: "synthetic-test-value" for keys in REQUIREMENTS.values() for key in keys}
        report = readiness(fake)
        self.assertFalse(report["live_connections_enabled"])
        self.assertTrue(all(not p["missing"] for p in report["providers"]))
        self.assertNotIn("synthetic-test-value", json.dumps(report))
        with self.assertRaisesRegex(ConfigError, "disabled"):
            require_live_access()

    def test_whitespace_credentials_are_missing(self):
        self.assertIn("LIVEKIT_URL", readiness({"LIVEKIT_URL": "  "})["providers"][0]["missing"])

    def test_sdk_agent_constructs_without_providers_or_network(self):
        self.assertIsNotNone(build_agent())

    def test_usage_is_unknown_until_measured(self):
        report = UsageLedger().snapshot()
        self.assertIsNone(report["cost"])
        self.assertTrue(all(item["by_source"] is None for item in report["measured_usage"].values()))

    def test_usage_accumulates_attempts_without_mixing_sources(self):
        usage = UsageLedger()
        usage.add("stt_audio", 30, source="provider")
        usage.add("stt_audio", 5, source="provider")  # Usage from a retry, when reported.
        usage.add("stt_audio", 36, source="instrumented")
        usage.add("retry", 1, source="instrumented")
        self.assertEqual(usage.snapshot()["measured_usage"]["stt_audio"]["by_source"], {"provider": 35, "instrumented": 36})

    def test_usage_rejects_invalid_observations(self):
        for value in (-1, float("nan"), float("inf"), True, "5"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                UsageLedger().add("stt_audio", value, source="provider")
        for metric, value, source in [("llm_input", .5, "provider"), ("transcript", 1, "provider"), ("stt_audio", 1, "invented")]:
            with self.subTest(metric=metric), self.assertRaises(ValueError):
                UsageLedger().add(metric, value, source=source)


if __name__ == "__main__":
    unittest.main()
