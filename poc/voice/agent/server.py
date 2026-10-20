"""Loopback-only control API. No provider action from GET, import or startup."""
import hmac
import re
from aiohttp import web
from control import Controller, Rejected

def create_app(env, *, allow_live=False, runtime_factory=None):
    secret=env.get('POC_CONTROL_SECRET','')
    if len(secret)<32: raise ValueError('POC_CONTROL_SECRET requires at least 32 characters')
    controller=Controller(env,allow_live=allow_live,runtime_factory=runtime_factory)
    @web.middleware
    async def guard(request,handler):
        if (request.remote not in ('127.0.0.1','::1') or request.host!='127.0.0.1:8001'
            or request.headers.get('Origin') is not None
            or not hmac.compare_digest(request.headers.get('Authorization',''),'Bearer '+secret)):
            return web.json_response({'error':'unauthorized'},status=403)
        owner=request.headers.get('X-Poc-Owner','')
        if not re.fullmatch(r'[0-9a-f]{32}',owner):
            return web.json_response({'error':'unauthorized'},status=403)
        try: response=await handler(request)
        except Rejected as error: response=web.json_response({'error':error.code},status=error.status)
        except Exception: response=web.json_response({'error':'local_control_failure'},status=500)
        response.headers['Cache-Control']='no-store'
        return response
    app=web.Application(middlewares=[guard],client_max_size=1024)
    async def start(request):
        try: payload=await request.json()
        except Exception: raise Rejected('invalid_request') from None
        return web.json_response(await controller.start(request.headers['X-Poc-Owner'],payload))
    async def stop(request): return web.json_response(await controller.stop(request.headers['X-Poc-Owner']))
    async def status(request): return web.json_response(controller.status(request.headers['X-Poc-Owner']))
    app.router.add_post('/start',start)
    app.router.add_post('/stop',stop)
    app.router.add_get('/status',status)
    async def cleanup(_): await controller.shutdown()
    app.on_cleanup.append(cleanup)
    return app
