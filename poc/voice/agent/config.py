"""Offline configuration validation. Values are never included in reports."""
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Mapping
from urllib.parse import urlsplit

REQUIREMENTS = json.loads((Path(__file__).parent.parent / "provider-env.json").read_text())
MODEL = "google/gemini-3-flash-preview"

class ConfigError(ValueError):
    pass

@dataclass(frozen=True)
class Config:
    url: str
    key: str = field(repr=False)
    secret: str = field(repr=False)
    deepgram: str = field(repr=False)
    sarvam: str = field(repr=False)
    control_secret: str = field(repr=False)
    model: str = MODEL
    speaker: str = "shubh"
    max_tokens: int = 128
    duration: int = 120
    turns: int = 5

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None):
        e = os.environ if env is None else env
        needed = [k for keys in REQUIREMENTS.values() for k in keys]
        missing = [k for k in needed if not e.get(k, "").strip()]
        if missing:
            raise ConfigError("Missing: " + ", ".join(missing))
        try:
            u = urlsplit(e['LIVEKIT_URL'])
            port = u.port
        except ValueError: raise ConfigError('Invalid LIVEKIT_URL') from None
        if (u.scheme != 'wss' or not u.hostname or not u.hostname.endswith('.livekit.cloud')
                or u.username or u.password or port or u.path not in ('', '/') or u.query or u.fragment):
            raise ConfigError('Invalid LIVEKIT_URL: expected a LiveKit Cloud wss origin')
        if len(e['POC_CONTROL_SECRET']) < 32 or len(e['POC_DEVELOPER_KEY']) < 32:
            raise ConfigError('POC_CONTROL_SECRET and POC_DEVELOPER_KEY require at least 32 characters')
        if e.get('INTERVIEWER_MODEL', MODEL) != MODEL:
            raise ConfigError('INTERVIEWER_MODEL requires a reviewed model decision')
        if e.get('SARVAM_SPEAKER', 'shubh') not in ('shubh', 'priya'):
            raise ConfigError('Invalid SARVAM_SPEAKER: use shubh or priya')
        def limit(key, default, low, high):
            try: n = int(e.get(key, str(default)))
            except ValueError: raise ConfigError('Invalid ' + key) from None
            if not low <= n <= high: raise ConfigError('Invalid ' + key)
            return n
        return cls(e['LIVEKIT_URL'].rstrip('/'), e['LIVEKIT_API_KEY'], e['LIVEKIT_API_SECRET'],
                   e['DEEPGRAM_API_KEY'], e['SARVAM_API_KEY'], e['POC_CONTROL_SECRET'],
                   e.get('INTERVIEWER_MODEL', MODEL), e.get('SARVAM_SPEAKER', 'shubh'),
                   limit('POC_MAX_OUTPUT_TOKENS',128,32,256), limit('POC_MAX_SECONDS',120,10,120),
                   limit('POC_MAX_TURNS',5,1,5))

def require_live_access(env=None, *, allow_live=False, now=None):
    e = os.environ if env is None else env
    now = time.time() if now is None else now
    if not allow_live or e.get('POC_LIVE_APPROVAL') != 'approved-one-session':
        raise ConfigError('Live connections disabled: separate explicit live-test approval required')
    if e.get('POC_BILLING_VERIFIED') != 'true' or e.get('POC_SARVAM_API_VERIFIED') != 'true':
        raise ConfigError('Live connections disabled: verify free credits, billing controls and Sarvam API entitlement')
    try: expiry = float(e.get('POC_APPROVAL_EXPIRES_AT', '0'))
    except ValueError: raise ConfigError('Invalid POC_APPROVAL_EXPIRES_AT') from None
    if not now < expiry <= now + 900:
        raise ConfigError('Live connections disabled: approval must expire within 15 minutes')
    return Config.from_env(e)

def readiness(environ=None):
    env = os.environ if environ is None else environ
    try: Config.from_env(env); issues = []
    except (ValueError, TypeError): issues = ['Configuration is incomplete or invalid; run --check after configuring the template.']
    return {'status':'ok', 'mode':'local-only', 'live_connections_enabled':False,
            'configuration_issues':issues, 'providers':[
                {'name':name,'missing':[key for key in keys if not env.get(key,'').strip()]}
                for name,keys in REQUIREMENTS.items()]}
