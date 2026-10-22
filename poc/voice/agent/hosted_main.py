"""Hosted worker entrypoint for LiveKit Cloud Build deployment."""
import logging
import sys
from livekit.agents import WorkerOptions, cli
from hosted_agent import HOSTED_AGENT_NAME, HostedConfig, entrypoint


def setup_safe_logging():
    """Configures minimal, sanitized operational logging.
    Never exposes provider tokens, judge credentials, transcripts,
    or raw network payloads to standard output or logs.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # Suppress verbose HTTP / IPC debug loggers that could print headers or payloads
    for noisy in ("aiohttp.access", "aiohttp.client", "urllib3", "livekit.agents.ipc"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def main():
    if "--check" in sys.argv:
        try:
            HostedConfig.from_env()
            print("hosted_agent: configuration valid (offline check passed)")
            return 0
        except Exception as e:
            print(f"hosted_agent: configuration check failed: {e}")
            return 1

    setup_safe_logging()
    logger = logging.getLogger("hosted_main")
    logger.info("Initializing worker for LiveKit Cloud (agent_name=%s)", HOSTED_AGENT_NAME)

    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name=HOSTED_AGENT_NAME,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
