/** Synthetic-only demo. This is NOT production student/faculty authentication. */
export function demoRequestAllowed(request: Request, enabled: string | undefined) {
 if (enabled !== '1') return false;
 const origins = ['http://127.0.0.1:3000'];
 const publicOrigin = process.env.MIRAI_PUBLIC_DEMO_ORIGIN?.trim();
 if (publicOrigin) {
  let url: URL;
  try { url = new URL(publicOrigin); } catch { return false; }
  // Public origin must be an exact HTTPS origin, not a path or wildcard.
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return false;
  origins.push(url.origin);
 }
 const host = request.headers.get('host');
 const forwardedHost = request.headers.get('x-forwarded-host');
 if (!host || (forwardedHost && forwardedHost !== host) || request.headers.has('forwarded')) return false;
 if (![null, 'same-origin'].includes(request.headers.get('sec-fetch-site'))) return false;
 const origin = request.headers.get('origin');
 return origins.some(allowedOrigin => {
  if (host !== new URL(allowedOrigin).host) return false;
  if (origin === allowedOrigin) return true;
  // Browser GETs from this same-origin UI have no Origin header.
  return request.method === 'GET' && origin === null && request.headers.get('x-mirai-demo') === '1';
 });
}
