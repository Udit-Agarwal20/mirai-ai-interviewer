import { localRequest, owner, safeJson } from "../../../../lib/access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function proxy(request: Request, action: "start" | "stop" | "status") {
  if (!localRequest(request)) return safeJson({error:"unauthorized"},403);
  let id: string;
  try { id=owner(request); } catch { return safeJson({error:"unauthorized"},403); }
  let body: string | undefined;
  if (action === "start") {
    try {
      const raw = await request.text();
      if (raw.length > 256) throw new Error();
      const data = JSON.parse(raw);
      if (data.consent !== true || data.preflight !== true || Object.keys(data).length !== 2) throw new Error();
      body=JSON.stringify({consent:true,preflight:true});
    } catch { return safeJson({error:"consent_and_preflight_required"},400); }
  }
  try {
    const result = await fetch(`http://127.0.0.1:8001/${action}`,{
      method:action === "status" ? "GET":"POST", body, cache:"no-store",
      headers:{Authorization:`Bearer ${process.env.POC_CONTROL_SECRET}`,"X-Poc-Owner":id,"Content-Type":"application/json"},
      signal:AbortSignal.timeout(action === "start" ? 10_000 : 5_000)
    });
    const data = await result.json();
    return safeJson(data,result.status);
  } catch { return safeJson({error:"local_agent_unavailable"},503); }
}
// POST is the only route capable of admission; GET never starts a provider session.
export async function POST(request: Request) { return proxy(request,"start"); }
export async function DELETE(request: Request) { return proxy(request,"stop"); }
export async function GET(request: Request) { return proxy(request,"status"); }
