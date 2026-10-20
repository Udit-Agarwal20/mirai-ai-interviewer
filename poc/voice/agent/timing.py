"""Bounded in-memory, content-free monotonic observations; no fabricated percentiles."""
import time

class Timeline:
    def __init__(self):
        self.started = time.monotonic()
        self.events = []
        self.turn = 0

    def mark(self, kind, *, turn=None):
        if len(self.events) < 512:
            self.events.append({'event':kind,'turn':self.turn if turn is None else turn,'seconds':time.monotonic()-self.started})

    def snapshot(self):
        samples=[]
        for turn in range(1,self.turn+1):
            events=[e for e in self.events if e['turn']==turn]
            end=next((e['seconds'] for e in reversed(events) if e['event']=='end_of_speech_received'),None)
            generated=next((e['seconds'] for e in events if e['event']=='tts_first_audio_generated'),None)
            sent=next((e['seconds'] for e in events if e['event']=='first_audio_to_rtc_source'),None)
            samples.append({'turn':turn,
                'detected_end_to_generated_seconds':None if end is None or generated is None else generated-end,
                'detected_end_to_rtc_source_seconds':None if end is None or sent is None else sent-end})
        return {'clock':'python_monotonic', 'events':list(self.events),'observed_samples':samples,
                'p95':None, 'audible_playback_latency':None,
                'note':'STT speech-end is provider detection receipt, not ground-truth acoustic end. Browser clocks are separate.'}
