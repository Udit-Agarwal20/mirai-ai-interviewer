"""Single-process local admission, ownership, timeout and cleanup authority."""
import asyncio
import secrets
import time
from dataclasses import dataclass, field
from config import require_live_access, ConfigError
from usage import UsageLedger
from timing import Timeline

class Rejected(Exception):
    def __init__(self, code, status=400): self.code,self.status=code,status

@dataclass
class Run:
    owner: str
    room: str = field(default_factory=lambda:'mirai-poc-'+secrets.token_hex(16))
    identity: str = field(default_factory=lambda:'developer-'+secrets.token_hex(16))
    done: asyncio.Event = field(default_factory=asyncio.Event)
    usage: UsageLedger = field(default_factory=UsageLedger)
    timeline: Timeline = field(default_factory=Timeline)
    state: str = 'starting'
    reason: str | None = None
    deadline: float = 0
    last_seen: float = field(default_factory=time.monotonic)
    task: asyncio.Task | None = None
    runtime: object = None
    token: str | None = field(default=None,repr=False)

    def finish(self, reason):
        if self.done.is_set(): return
        self.reason=reason
        if any(x in reason for x in ('failure','quota','authentication','timeout')):
            self.usage.add('failure',1,source='instrumented')
        self.done.set()
        if self.runtime and hasattr(self.runtime, "abort_now"):
            self.runtime.abort_now()

    def snapshot(self):
        return {'state':self.state,'reason':self.reason,'remaining_seconds':max(0,self.deadline-time.monotonic()),
                'usage':self.usage.snapshot(),'credit_estimate':self.usage.credit_estimate(),'timing':self.timeline.snapshot()}

class Controller:
    def __init__(self, env, *, allow_live=False, runtime_factory=None):
        self.env,self.allow_live=env,allow_live
        self.runtime_factory=runtime_factory
        self.run=None
        self.used=False
        self.lock=asyncio.Lock()

    async def start(self, owner, payload):
        if payload != {'consent':True,'preflight':True}: raise Rejected('consent_and_preflight_required')
        async with self.lock:
            if self.run and self.run.state != 'ended': raise Rejected('session_already_exists',409)
            if self.used: raise Rejected('one_session_approval_consumed',409)
            try: config=require_live_access(self.env,allow_live=self.allow_live)
            except ConfigError: raise Rejected('live_approval_or_configuration_missing',403) from None
            self.used=True
            run=self.run=Run(owner=owner)
            run.deadline=time.monotonic()+config.duration
            if self.runtime_factory is None:
                from runtime import LiveRuntime
                factory=LiveRuntime
            else: factory=self.runtime_factory
            run.runtime=factory(config,run)
            ready=asyncio.Future()
            ready.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
            run.task=asyncio.create_task(self._run(run,ready))
        try:
            # Request cancellation does not kill the supervisor or strand a remote room.
            token=await asyncio.shield(ready)
            if run.done.is_set(): raise Rejected('session_ended',409)
            return {'token':token,'url':config.url,'room':run.room,'identity':run.identity,
                    'remaining_seconds':max(0,run.deadline-time.monotonic())}
        except asyncio.CancelledError:
            run.finish('start_cancelled')
            raise

    async def _run(self, run, ready):
        async def conversation():
            token=await run.runtime.prepare()
            if not ready.done(): ready.set_result(token)
            await run.runtime.converse()
            run.finish('agent_completed')
        task=asyncio.create_task(conversation())
        try:
            while not run.done.is_set():
                remaining=run.deadline-time.monotonic()
                if remaining<=0: run.finish('session_timeout'); break
                if time.monotonic()-run.last_seen>12: run.finish('browser_heartbeat_timeout'); break
                if task.done():
                    try: task.result()
                    except Exception: run.finish('startup_or_transport_failure')
                    break
                try: await asyncio.wait_for(run.done.wait(),timeout=min(.25,remaining))
                except TimeoutError: pass
        finally:
            run.state='stopping'
            task.cancel()
            try: await task
            except (asyncio.CancelledError,Exception): pass
            if not ready.done(): ready.set_exception(Rejected('session_start_failed',502))
            try: await run.runtime.close()
            except Exception: run.reason='cleanup_unconfirmed_check_dashboard'
            run.runtime=None
            run.state='ended'
            run.timeline.mark('session_ended')

    def owned(self,owner):
        if not self.run or self.run.owner!=owner: raise Rejected('no_owned_session',404)
        return self.run

    def status(self,owner):
        run=self.owned(owner)
        run.last_seen=time.monotonic()
        return run.snapshot()

    async def stop(self,owner):
        run=self.owned(owner)
        run.finish('manual_stop')
        # Return immediately; status polling exposes stopping/cleanup failure.
        return run.snapshot()

    async def shutdown(self):
        if self.run and self.run.task:
            self.run.finish('server_shutdown')
            await self.run.task
