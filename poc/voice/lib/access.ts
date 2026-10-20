import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const origin = "http://127.0.0.1:3000";
export function localRequest(request: Request) {
  return request.headers.get("host") === "127.0.0.1:3000"
    && (request.headers.get("origin") === origin || (request.method === "GET" && request.headers.get("origin") === null && request.headers.get("x-poc-request") === "1"))
    // Next adds this header internally; require the exact local host when present.
    && [null, "127.0.0.1:3000"].includes(request.headers.get("x-forwarded-host"))
    && !request.headers.has("forwarded")
    && [null, "same-origin"].includes(request.headers.get("sec-fetch-site"));
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function secret() {
  const value = process.env.POC_CONTROL_SECRET ?? "";
  if (value.length < 32) throw new Error("local_access_unconfigured");
  return value;
}
function sign(payload: string) { return createHmac("sha256", secret()).update(payload).digest("hex"); }
export function issueCookie() {
  const payload = `${randomBytes(16).toString("hex")}.${Date.now() + 900_000}`;
  return `${payload}.${sign(payload)}`;
}
export function owner(request: Request) {
  const token = request.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith("mirai_poc="))?.slice(10);
  if (!token) throw new Error("unauthorized");
  const [id, expires, signature, extra] = token.split(".");
  if (extra || !/^[0-9a-f]{32}$/.test(id) || !/^\d+$/.test(expires) || Number(expires) <= Date.now()
    || Number(expires) > Date.now() + 900_000 || !signature || !equal(signature, sign(`${id}.${expires}`))) throw new Error("unauthorized");
  return id;
}
export function safeJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
