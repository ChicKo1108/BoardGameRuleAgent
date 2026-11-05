export const runtime = "nodejs";
export function GET() {
  // Liveness only. This does not claim database/model readiness.
  return Response.json({ status: "ok", service: "boardgame-rules-agent", check: "liveness" });
}
