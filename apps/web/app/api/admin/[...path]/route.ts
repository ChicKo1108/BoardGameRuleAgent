import { handleAdmin } from "@boardgame/backend";
import { getDatabase } from "../../../../server/database";
import { getIngestion } from "../../../../server/ingestion";
import { getVectors } from "../../../../server/vectors";
import { getEvaluations } from "../../../../server/evaluations";
import { getAnswers } from "../../../../server/answers";
import { getAnswerEvaluations } from "../../../../server/answer-evaluations";
import { getPublications } from "../../../../server/publications";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handler(request: Request) {
  return handleAdmin(request, {
    getDb: getDatabase,
    getIngestion,
    getVectors,
    getEvaluations,
    getAnswers,
    getAnswerEvaluations,
    getPublications,
    adminToken: () => process.env.ADMIN_API_TOKEN,
    reportError: (_error, requestId) =>
      console.error(JSON.stringify({ event: "admin_api_failure", requestId })),
  });
}
export { handler as GET, handler as POST, handler as PATCH, handler as PUT };
