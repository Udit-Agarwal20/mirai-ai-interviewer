"""One local AgentSession using LiveKit RTC; no hosted worker, recorder or database."""
import asyncio
import time
from datetime import timedelta
import aiohttp
from livekit import api, rtc
from livekit.agents import AgentSession
from livekit.agents.voice import room_io
from livekit.agents.voice.agent_session import SessionConnectOptions
from interview import InterviewController, QUESTIONS
from providers import adapters, InterviewAgent, NO_RETRY, failure_code


def participant_token(config, room, identity, *, agent=False):
    return (api.AccessToken(config.key, config.secret).with_identity(identity)
            .with_kind('agent' if agent else 'standard')
            .with_ttl(timedelta(seconds=30))
            .with_grants(api.VideoGrants(room_join=True, room=room, can_publish=True,
                         can_subscribe=True, can_publish_data=False,
                         can_publish_sources=['microphone'], can_update_own_metadata=agent))
            .to_jwt())


def verify_participant_token(config, token, room, identity):
    claims = api.TokenVerifier(config.key, config.secret, leeway=timedelta(seconds=0)).verify(token)
    v = claims.video
    if (v is None or claims.identity != identity or v.room != room or not v.room_join or not v.can_publish
            or not v.can_subscribe or v.can_publish_data is not False
            or v.can_update_own_metadata is not False or claims.kind != 'standard'
            or v.can_publish_sources != ['microphone'] or v.room_admin or v.room_create or v.room_record):
        raise ValueError('invalid_scope')
    return claims


class LiveRuntime:
    def __init__(self, config, run):
        self.config, self.run = config, run
        self.http = None
        self.api = None
        self.room = None
        self.session = None
        self.models = ()
        self.room_created = False
        self.connected_at = None
        self.participant_at = None
        self.closed = False

    async def prepare(self):
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8))
        self.api = api.LiveKitAPI(self.config.url, self.config.key, self.config.secret, session=self.http)
        # Mark before awaiting: create may succeed remotely even if the response times out.
        self.room_created = True
        await self.api.room.create_room(api.CreateRoomRequest(name=self.run.room,
            empty_timeout=15, departure_timeout=5, max_participants=2))
        return participant_token(self.config, self.run.room, self.run.identity)

    async def converse(self):
        self.room = rtc.Room()
        @self.room.on('disconnected')
        def disconnected(*_): self.run.finish('room_disconnected')
        @self.room.on('reconnecting')
        def reconnecting(*_): self.run.finish('room_reconnecting')
        @self.room.on('participant_disconnected')
        def left(p):
            if p.identity == self.run.identity:
                if self.participant_at is not None:
                    self.run.usage.add('livekit_participant',time.monotonic()-self.participant_at,source='instrumented')
                    self.participant_at = None
                self.run.finish('participant_disconnected')
        joined = asyncio.Event()
        @self.room.on('participant_connected')
        def arrived(p):
            if p.identity == self.run.identity:
                self.participant_at = time.monotonic()
                joined.set()
            else: self.run.finish('unexpected_participant')
        await self.room.connect(self.config.url, participant_token(self.config,self.run.room,'agent-'+self.run.identity,agent=True))
        self.connected_at = time.monotonic()
        for p in self.room.remote_participants.values(): arrived(p)
        await asyncio.wait_for(joined.wait(), timeout=20)
        self.models = adapters(self.config,self.http)
        stt, model, tts = self.models
        self.session = AgentSession(stt=stt,llm=model,tts=tts,
            turn_handling={'turn_detection':'stt','preemptive_generation':{'enabled':False},
                           'interruption':{'enabled':False}},
            user_away_timeout=20, session_close_transcript_timeout=0,
            conn_options=SessionConnectOptions(stt_conn_options=NO_RETRY,llm_conn_options=NO_RETRY,
                                               tts_conn_options=NO_RETRY,max_unrecoverable_errors=0))
        @self.session.on('error')
        def error(ev):
            stage={'stt_error':'stt','llm_error':'llm','tts_error':'tts'}.get(getattr(ev.error,'type',''),'provider')
            self.run.finish(failure_code(stage,getattr(ev.error,'error',ev.error)))
        @self.session.on('close')
        def close(*_): self.run.finish('agent_closed')
        @self.session.on('user_state_changed')
        def user_state(ev):
            if ev.new_state == 'away': self.run.finish('no_speech_timeout')
        @self.session.on('agent_state_changed')
        def agent_state(ev):
            if ev.new_state == 'speaking': self.run.timeline.mark('agent_speaking_sdk')
            if ev.old_state == 'speaking': self.run.timeline.mark('response_playout_complete_sdk')
        @self.session.on('metrics_collected')
        def metric(ev):
            m = ev.metrics
            # STT/TTS SDK quantities are instrumentation, not verified billed quantities.
            if m.type == 'stt_metrics' and m.audio_duration > 0:
                self.run.usage.add('stt_audio',m.audio_duration,source='instrumented')
            elif m.type == 'tts_metrics':
                if m.characters_count > 0: self.run.usage.add('tts_text',m.characters_count,source='instrumented')
                if m.audio_duration > 0: self.run.usage.add('tts_audio',m.audio_duration,source='instrumented')
        controller = InterviewController(self.config.turns)
        agent = InterviewAgent(model,controller,self.run.timeline,self.run.usage,self.run.finish)
        await self.session.start(agent=agent,room=self.room,record=False,
            room_options=room_io.RoomOptions(participant_identity=self.run.identity,
                audio_input=room_io.AudioInputOptions(pre_connect_audio=False),video_input=False,
                text_input=False,text_output=False,audio_output=True))
        if self.session.output.audio:
            self.session.output.audio.on('playback_started',lambda _:self.run.timeline.mark('first_audio_to_rtc_source'))
        self.run.state = 'active'
        await self.session.say(QUESTIONS['opening'], allow_interruptions=False)
        await self.run.done.wait()

    def abort_now(self):
        if self.session:
            self.session.input.set_audio_enabled(False)
            self.session.output.set_audio_enabled(False)
            try: self.session.interrupt(force=True)
            except RuntimeError: pass  # startup/teardown may have no active speech activity
            self.session.shutdown(drain=False)

    async def close(self):
        if self.closed: return
        self.closed = True
        self.abort_now()
        cleanup_failed = False
        async def attempt(action):
            nonlocal cleanup_failed
            try:
                async with asyncio.timeout(5): await action()
            except Exception: cleanup_failed = True
        closers=[model.aclose for model in self.models]
        if self.session: closers.append(self.session.aclose)
        if self.room: closers.append(self.room.disconnect)
        await asyncio.gather(*(attempt(close) for close in closers))
        if self.room_created and self.api:
            await attempt(lambda:self.api.room.delete_room(api.DeleteRoomRequest(room=self.run.room)))
        if self.api: await attempt(self.api.aclose)
        if self.http: await attempt(self.http.close)
        now = time.monotonic()
        if self.connected_at is not None:
            self.run.usage.add('agent_session',now-self.connected_at,source='instrumented')
            self.run.usage.add('livekit_participant',now-self.connected_at,source='instrumented')
        if self.participant_at is not None:
            self.run.usage.add('livekit_participant',now-self.participant_at,source='instrumented')
        self.session = None
        self.models = ()
        self.room = None
        if cleanup_failed: self.run.reason = 'cleanup_unconfirmed_check_dashboard'
