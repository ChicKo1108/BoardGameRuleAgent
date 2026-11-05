import { handleConversations } from "@boardgame/backend";
import { getConversations } from "../../../../server/conversations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = (request: Request) =>
  handleConversations(request, getConversations);
export { handler as GET, handler as POST };
