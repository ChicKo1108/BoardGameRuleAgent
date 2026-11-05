import { ConversationService } from "@boardgame/backend";
import { getDatabase } from "./database";
import { getSessions } from "./sessions";
import { getPublications } from "./publications";
import { getAnswers } from "./answers";
export async function getConversations() {
  return new ConversationService(
    await getDatabase(),
    await getSessions(),
    await getPublications(),
    getAnswers,
  );
}
