/** No production authorization: this guard is only for explicitly enabled loopback demos. */
export function demoRequestAllowed(request: Request, enabled: string | undefined) {
 return enabled==='1' && request.headers.get('host')==='127.0.0.1:3000'
  && [null,'127.0.0.1:3000'].includes(request.headers.get('x-forwarded-host'))
  && !request.headers.has('forwarded')
  && [null,'same-origin'].includes(request.headers.get('sec-fetch-site'))
  && (request.headers.get('origin')==='http://127.0.0.1:3000'
    || (request.method==='GET' && request.headers.get('origin')===null && request.headers.get('x-mirai-demo')==='1'));
}
