import { equal, issueCookie, localRequest, safeJson } from "../../../../lib/access";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!localRequest(request)) return safeJson({error:"unauthorized"},403);
  try {
    const raw = await request.text();
    if (raw.length > 1024) return safeJson({error:"invalid_request"},400);
    const data = JSON.parse(raw);
    const key = process.env.POC_DEVELOPER_KEY ?? "";
    if (key.length < 32 || typeof data.key !== "string" || !equal(data.key,key)) return safeJson({error:"unauthorized"},403);
    const response = safeJson({status:"local_access_granted"});
    response.headers.set("Set-Cookie",`mirai_poc=${issueCookie()}; HttpOnly; SameSite=Strict; Path=/api/poc; Max-Age=900`);
    return response;
  } catch { return safeJson({error:"local_access_unavailable"},403); }
}
