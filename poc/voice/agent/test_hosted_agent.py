import sys
import os
"""Offline unit tests for hosted agent configuration, limits, and behavior."""
import asyncio
import unittest
from hosted_agent import (
    HOSTED_AGENT_NAME,
    MAX_DURATION_SECONDS,
    MAX_TURNS,
    MAX_OUTPUT_TOKENS,
    HostedConfig,
    perform_bounded_cleanup,
)
from interview import InterviewController, QUESTIONS
from providers import NO_RETRY


class TestHostedAgent(unittest.TestCase):
    def test_hosted_constants(self):
        self.assertEqual(HOSTED_AGENT_NAME, "mirai-judge-agent")
        self.assertEqual(MAX_DURATION_SECONDS, 60)
        self.assertEqual(MAX_TURNS, 3)
        self.assertEqual(MAX_OUTPUT_TOKENS, 128)

    def test_hosted_config_validation(self):
        # Missing LiveKit credentials must fail
        with self.assertRaises(ValueError):
            HostedConfig.from_env({})

        valid_env = {
            "LIVEKIT_URL": "wss://test.livekit.cloud",
            "LIVEKIT_API_KEY": "test-key",
            "LIVEKIT_API_SECRET": "test-secret",
            "DEEPGRAM_API_KEY": "dg-key",
            "SARVAM_API_KEY": "sv-key",
        }
        cfg = HostedConfig.from_env(valid_env)
        self.assertEqual(cfg.url, "wss://test.livekit.cloud")
        self.assertEqual(cfg.duration, 60)
        self.assertEqual(cfg.turns, 3)
        self.assertEqual(cfg.max_tokens, 128)
        self.assertEqual(cfg.model, "google/gemini-3-flash-preview")
        self.assertEqual(cfg.speaker, "shubh")

    def test_interview_controller_strictly_bounds_to_three_turns(self):
        controller = InterviewController(max_turns=MAX_TURNS)
        # Turn 1
        self.assertTrue(controller.accept_turn())
        self.assertEqual(controller.turns, 1)
        next_q = controller.followup("deeper")
        self.assertEqual(next_q, QUESTIONS["deeper"])

        # Turn 2
        self.assertTrue(controller.accept_turn())
        self.assertEqual(controller.turns, 2)
        next_q2 = controller.followup("partial")
        self.assertEqual(next_q2, QUESTIONS["partial"])

        # Turn 3 - reaches limit
        self.assertFalse(controller.accept_turn())
        self.assertEqual(controller.turns, 3)

        # Subsequent turn rejected
        self.assertFalse(controller.accept_turn())

    def test_interview_controller_rejects_arbitrary_or_unbounded_output(self):
        controller = InterviewController(max_turns=MAX_TURNS)
        # Valid labels
        for label in ("deeper", "partial", "next", "redirect"):
            c = InterviewController(max_turns=MAX_TURNS)
            c.followup(label)

        # Invalid labels / model hallucinatory text
        for invalid in ("Hello world", "deeper and more", "42", "eval: good", "DROP TABLE"):
            with self.assertRaises(ValueError):
                controller.followup(invalid)

    def test_no_provider_retries_configured(self):
        self.assertEqual(NO_RETRY.max_retry, 0)
        self.assertEqual(NO_RETRY.timeout, 8.0)

    def test_cleanup_bounds_execution_and_handles_exceptions(self):
        async def run_cleanup_test():
            class MockSession:
                def __init__(self):
                    self.audio_disabled = False
                    self.shutdown_called = False
                    self.input = self
                    self.output = self
                def set_audio_enabled(self, val):
                    self.audio_disabled = not val
                def interrupt(self, force=True):
                    pass
                def shutdown(self, drain=False):
                    self.shutdown_called = True
                async def aclose(self):
                    pass

            class MockCtx:
                def __init__(self):
                    self.deleted = False
                    self.room = self
                async def disconnect(self):
                    pass
                async def delete_room(self):
                    self.deleted = True

            session = MockSession()
            ctx = MockCtx()

            await perform_bounded_cleanup(ctx, session, (), None, "test_timeout")
            self.assertTrue(session.audio_disabled)
            self.assertTrue(session.shutdown_called)
            self.assertTrue(ctx.deleted)

        asyncio.run(run_cleanup_test())



    def test_safe_logging_and_check_flag(self):
        import subprocess
        agent_dir = os.path.dirname(__file__)
        main_py = os.path.join(agent_dir, "hosted_main.py")
        # Check flag failure without env
        res = subprocess.run([sys.executable, main_py, "--check"], capture_output=True, text=True, cwd=agent_dir)
        self.assertEqual(res.returncode, 1)
        self.assertIn("configuration check failed", res.stdout)

        # Check flag success with minimal env
        env = {
            **os.environ,
            "LIVEKIT_URL": "wss://test.livekit.cloud",
            "LIVEKIT_API_KEY": "test-key",
            "LIVEKIT_API_SECRET": "test-secret",
        }
        res2 = subprocess.run([sys.executable, main_py, "--check"], capture_output=True, text=True, env=env, cwd=agent_dir)
        self.assertEqual(res2.returncode, 0)
        self.assertIn("configuration valid", res2.stdout)

if __name__ == "__main__":
    unittest.main()
