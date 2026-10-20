"""Official adapters. Constructed only inside a separately armed, manually started run."""
import asyncio
import hashlib
from livekit.agents import Agent, APIConnectOptions, StopResponse, inference, llm, stt
from livekit.plugins import deepgram, sarvam
from interview import InterviewController, QUESTIONS

NO_RETRY = APIConnectOptions(max_retry=0, timeout=8.0)

class NoProbeInference(inference.LLM):
    async def _prewarm_impl(self):
        # AgentSession prewarms LLMs during construction. Never make a model-list probe.
        pass


def adapters(config, http):
    return (
        deepgram.STT(api_key=config.deepgram, model='nova-3', language='multi',
                     interim_results=True, vad_events=True, endpointing_ms=300,
                     utterance_end_ms=1000, mip_opt_out=True, http_session=http),
        NoProbeInference(model=config.model, provider='google', api_key=config.key,
                         api_secret=config.secret, base_url='https://agent-gateway.livekit.cloud/v1',
                         extra_kwargs={'max_completion_tokens':config.max_tokens}),
        sarvam.TTS(api_key=config.sarvam, model='bulbul:v3', target_language_code='en-IN',
                   speaker=config.speaker, pace=1.0, http_session=http),
    )


def failure_code(stage, error):
    status = getattr(error, 'status_code', None) or getattr(error, 'status', None)
    if status in (402,429): return stage + '_quota_or_credit'
    if status in (401,403): return stage + '_authentication'
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)): return stage + '_timeout'
    return stage + '_failure'


class InterviewAgent(Agent):
    def __init__(self, model, controller, timeline, usage, finish):
        super().__init__(instructions='Developer technical viva; only fixture questions may be spoken.')
        self.model_adapter = model
        self.controller = controller
        self.timeline = timeline
        self.usage = usage
        self.finish = finish
        self.segments = set()

    async def on_user_turn_completed(self, turn_ctx, new_message):
        self.timeline.turn += 1
        self.timeline.mark('user_turn_committed')
        if not self.controller.accept_turn():
            self.finish('turn_limit')
            raise StopResponse()

    async def stt_node(self, audio, model_settings):
        try:
            async for event in Agent.default.stt_node(self, audio, model_settings):
                if event.type == stt.SpeechEventType.FINAL_TRANSCRIPT and event.alternatives:
                    a = event.alternatives[0]
                    # Deduplicate exact timestamped segments, not repeated spoken words.
                    key = (event.request_id, a.start_time, a.end_time, hashlib.sha256(a.text.encode()).digest())
                    if key in self.segments: continue
                    self.segments.add(key)
                    if len(self.segments) > 512: self.finish('transcript_limit'); return
                    self.timeline.mark('stt_final',turn=self.timeline.turn+1)
                elif event.type in (stt.SpeechEventType.START_OF_SPEECH, stt.SpeechEventType.END_OF_SPEECH):
                    self.timeline.mark(event.type.value + '_received',turn=self.timeline.turn+1)
                # Interim segments are handled by the SDK; never committed or persisted here.
                yield event
        except Exception as error:
            self.finish(failure_code('stt', error))
            raise StopResponse() from None

    async def llm_node(self, chat_ctx, tools, model_settings):
        reported_usage = None
        try:
            answer = next((m.text_content for m in reversed(chat_ctx.items)
                           if isinstance(m, llm.ChatMessage) and m.role == 'user'), '')
            ctx = llm.ChatContext()
            ctx.add_message(role='system', content=self.controller.instructions())
            ctx.add_message(role='user', content=(answer or '')[:4000])
            output = ''
            self.timeline.mark('llm_start')
            async with asyncio.timeout(12):
                async with self.model_adapter.chat(chat_ctx=ctx, conn_options=NO_RETRY) as stream:
                    async for chunk in stream:
                        if chunk.usage is not None:
                            # Stream usage is cumulative; retain the latest actual report once.
                            reported_usage = chunk.usage
                        if chunk.delta and chunk.delta.content:
                            if not output: self.timeline.mark('llm_first_token')
                            output += chunk.delta.content
                            if len(output) > 128: raise ValueError('invalid_interviewer_output')
            self.timeline.mark('llm_complete')
            # Buffer/validate before TTS: model output can never speak instructions or answers.
            yield self.controller.followup(output)
        except Exception as error:
            self.finish(failure_code('llm', error))
            raise StopResponse() from None
        finally:
            if reported_usage is not None:
                self.usage.add('llm_input',reported_usage.prompt_tokens,source='provider')
                self.usage.add('llm_output',reported_usage.completion_tokens,source='provider')

    async def tts_node(self, text, model_settings):
        first = True
        try:
            async for frame in Agent.default.tts_node(self, text, model_settings):
                if first:
                    self.timeline.mark('tts_first_audio_generated')
                    first = False
                yield frame
            self.timeline.mark('tts_generation_complete')
        except Exception as error:
            self.finish(failure_code('tts', error))
            raise StopResponse() from None
