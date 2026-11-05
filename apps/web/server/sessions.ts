import {
  SessionService,
  sessionConfigFromEnvironment,
} from "@boardgame/backend";
import { getDatabase } from "./database";
export async function getSessions() {
  const config = sessionConfigFromEnvironment();
  return new SessionService(await getDatabase(), config);
}
