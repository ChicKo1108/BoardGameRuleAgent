import { handleSession } from "@boardgame/backend";
import { getSessions } from "../../../server/sessions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = (request: Request) => handleSession(request, getSessions);
export { handler as GET, handler as POST, handler as DELETE };
