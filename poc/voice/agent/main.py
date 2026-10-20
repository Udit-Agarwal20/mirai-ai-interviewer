"""Offline check by default. Serving does not connect; only an armed POST start can."""
import argparse
import json
import logging
import os
from config import readiness, require_live_access, ConfigError


def build_agent():
    from livekit.agents import Agent
    return Agent(instructions='Inactive developer foundation.')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--serve',action='store_true')
    parser.add_argument('--allow-live',action='store_true',help='Only after separate explicit approval and dashboard verification')
    parser.add_argument('--connect',action='store_true',help='Unsupported: use manual browser start')
    args=parser.parse_args()
    if args.connect:
        print(json.dumps({'status':'blocked','message':'Use manual browser start after approval; no automatic connections.'})); return 2
    if not args.serve:
        print(json.dumps(readiness(),indent=2)); return 0
    try:
        if args.allow_live: require_live_access(allow_live=True)
        from server import create_app
        app=create_app(dict(os.environ),allow_live=args.allow_live)
    except (ConfigError,ValueError) as error:
        print(json.dumps({'status':'blocked','message':str(error)})); return 2
    # SDK logs may include recognized speech, provider payloads or connection credentials.
    # This diagnostic uses only sanitized status codes and in-memory numeric telemetry.
    logging.disable(logging.CRITICAL)
    from aiohttp import web
    web.run_app(app,host='127.0.0.1',port=8001,access_log=None,print=None)
    return 0

if __name__=='__main__': raise SystemExit(main())
