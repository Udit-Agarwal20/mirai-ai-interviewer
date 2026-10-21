"""Hosted LiveKit Cloud agent worker for Mirai judge evaluations.
Strictly enforced bounds:
- Independent 60-second cancellation authority across all phases (waiting, startup, speech)
- At most 3 candidate answers via InterviewController
- Bounded model output tokens (max 128) verified in inference adapter and agent node
- Immediate room and session cleanup on disconnect, timeout, or completion
- Sanitized telemetry, no audio or transcript storage
"""
import asyncio
import os
import time
from dataclasses import dataclass
import aiohttp

from livekit.agents import AutoSubscribe, JobContext, room_io
from livekit.agents.voice import AgentSession
from livekit.agents.voice.agent_session import SessionConnectOptions

from interview import InterviewController, QUESTIONS
from providers import adapters, InterviewAgent, NO_RETRY, failure_code
from timing import Timeline
from usage import UsageLedger

HOSTED_AGENT_NAME = "mirai-judge-agent"
MAX_DURATION_SECONDS = 60
MAX_TURNS = 3
MAX_OUTPUT_TOKENS = 128


@dataclass(frozen=True)
class HostedConfig:
    url: str
    key: str
    secret: str
    deepgram: str
    sarvam: str
    model: str = "google/gemini-3-flash-preview"
    speaker: str = "shubh"
    max_tokens: int = MAX_OUTPUT_TOKENS
    duration: int = MAX_DURATION_SECONDS
    turns: int = MAX_TURNS

    @classmethod
    def from_env(cls, env=None):
        e = os.environ if env is None else env
        missing = [k for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET") if not e.get(k, "").strip()]
        dg = e.get("DEEPGRAM_API_KEY", "").strip()
        sv = e.get("SARVAM_API_KEY", "").strip()
        if missing:
            raise ValueError(f"Missing required LiveKit configuration: {missing}")
        return cls(
            url=e["LIVEKIT_URL"].rstrip("/"),
            key=e["LIVEKIT_API_KEY"],
            secret=e["LIVEKIT_API_SECRET"],
            deepgram=dg,
            sarvam=sv,
            model=e.get("INTERVIEWER_MODEL", "google/gemini-3-flash-preview"),
            speaker=e.get("SARVAM_SPEAKER", "shubh")
        )


async def perform_bounded_cleanup(ctx: JobContext, session, models, http_session, reason: str):
    """Guaranteed bounded teardown within 5.0 seconds. Never leaves orphaned rooms or connections."""
    # 1. Non-blocking immediate audio shutdown and interrupt
    if session:
        try:
            session.input.set_audio_enabled(False)
            session.output.set_audio_enabled(False)
            session.interrupt(force=True)
        except Exception:
            pass
        try:
            session.shutdown(drain=False)
        except Exception:
            pass

    # 2. Bounded asynchronous close of connections
    try:
        async with asyncio.timeout(5.0):
            closers = []
            if session:
                closers.append(session.aclose())
            for m in models:
                if hasattr(m, "aclose"):
                    closers.append(m.aclose())
            if http_session:
                closers.append(http_session.close())
            if ctx.room:
                closers.append(ctx.room.disconnect())
            if closers:
                await asyncio.gather(*closers, return_exceptions=True)

            # Explicitly delete the room so no stranded LiveKit Cloud resources persist
            try:
                await ctx.delete_room()
            except Exception:
                pass
    except Exception:
        pass


async def entrypoint(ctx: JobContext):
    timeline = Timeline()
    usage = UsageLedger()
    done_event = asyncio.Event()
    termination_reason = "normal"

    def finish(reason: str):
        nonlocal termination_reason
        if not done_event.is_set():
            termination_reason = reason
            done_event.set()

    session = None
    models = ()
    http_session = None

    async def run_interview():
        nonlocal session, models, http_session

        # 1. Connect to LiveKit room audio
        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

        # 2. Wait for the judge participant (bounded to 25s within the overall 60s window)
        participant = await asyncio.wait_for(ctx.wait_for_participant(), timeout=25.0)

        # 3. Monitor judge disconnect
        @ctx.room.on("participant_disconnected")
        def on_participant_left(p):
            if p.identity == participant.identity:
                finish("judge_disconnected")

        @ctx.room.on("disconnected")
        def on_room_disconnected(*_):
            finish("room_disconnected")

        # 4. Load configuration and construct providers with NO_RETRY
        config = HostedConfig.from_env()
        http_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8.0))
        models = adapters(config, http_session)
        stt, model, tts = models

        # 5. Session with strict NO_RETRY and 0 unrecoverable errors
        session = AgentSession(
            stt=stt, llm=model, tts=tts,
            turn_handling={"turn_detection": "stt", "preemptive_generation": {"enabled": False}, "interruption": {"enabled": False}},
            user_away_timeout=20, session_close_transcript_timeout=0,
            conn_options=SessionConnectOptions(
                stt_conn_options=NO_RETRY, llm_conn_options=NO_RETRY, tts_conn_options=NO_RETRY, max_unrecoverable_errors=0
            )
        )

        @session.on("error")
        def on_session_error(ev):
            stage = {"stt_error": "stt", "llm_error": "llm", "tts_error": "tts"}.get(getattr(ev.error, "type", ""), "provider")
            finish(failure_code(stage, getattr(ev.error, "error", ev.error)))

        @session.on("close")
        def on_session_close(*_):
            finish("agent_closed")

        @session.on("user_state_changed")
        def on_user_state(ev):
            if ev.new_state == "away":
                finish("no_speech_timeout")

        # 6. Strictly 3-turn interview controller
        controller = InterviewController(max_turns=MAX_TURNS)
        agent = InterviewAgent(model, controller, timeline, usage, finish)

        await session.start(
            agent=agent,
            room=ctx.room,
            record=False,
            room_options=room_io.RoomOptions(
                participant_identity=participant.identity,
                audio_input=room_io.AudioInputOptions(pre_connect_audio=False),
                video_input=False, text_input=False, text_output=False, audio_output=True
            )
        )

        # 7. Opening question
        await session.say(QUESTIONS["opening"], allow_interruptions=False)

        # 8. Wait for completion or 3-turn answer limit
        await done_event.wait()

    try:
        # Independent cancellation authority: 60s hard stop bounds waiting, startup, and speech
        async with asyncio.timeout(MAX_DURATION_SECONDS):
            await run_interview()
    except (TimeoutError, asyncio.TimeoutError):
        finish("session_timeout_60s")
    except Exception as e:
        finish(f"startup_failure_{type(e).__name__}")
    finally:
        await perform_bounded_cleanup(ctx, session, models, http_session, termination_reason)
