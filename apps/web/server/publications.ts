import { PublicationService } from "@boardgame/backend";
import { getDatabase } from "./database";
import { getAnswers } from "./answers";
export async function getPublications() {
  return new PublicationService(await getDatabase(), getAnswers);
}
