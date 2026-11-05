import { handleAdmin } from "@boardgame/backend";
import { getDatabase } from "../../../../server/database";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handler(request: Request) {
  return handleAdmin(request, {
    getDb: getDatabase,
    adminToken: () => process.env.ADMIN_API_TOKEN,
    reportError: (_error, requestId) =>
      console.error(JSON.stringify({ event: "admin_api_failure", requestId })),
  });
}
export { handler as GET, handler as POST, handler as PATCH };
