"""Hosted worker entrypoint for LiveKit Cloud Build deployment."""
import logging
import sys
from livekit.agents import WorkerOptions, cli
from hosted_agent import HOSTED_AGENT_NAME, HostedConfig, entrypoint

def main():
    if "--check" in sys.argv:
        try:
            HostedConfig.from_env()
            print("hosted_agent: configuration valid (offline check passed)")
            return 0
        except Exception as e:
            print(f"hosted_agent: configuration check failed: {e}")
            return 1

    # Enforce sanitized logging: never expose transcripts, tokens, or raw payloads
    logging.disable(logging.CRITICAL)
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name=HOSTED_AGENT_NAME,
        )
    )
    return 0

if __name__ == "__main__":
    sys.exit(main())
