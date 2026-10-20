import { localReadiness } from "../../../../lib/config";

export const dynamic = "force-dynamic";

// Diagnostic route for this isolated PoC, not production API-030.
export async function GET() {
  return Response.json(localReadiness(), {
    headers: { "Cache-Control": "no-store" }
  });
}
