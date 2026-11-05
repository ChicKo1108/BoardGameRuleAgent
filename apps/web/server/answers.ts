import { AnswerService } from "@boardgame/backend";
import { chatProviderFromEnvironment } from "@boardgame/agent";
import { getDatabase } from "./database";
import { getVectors } from "./vectors";
export async function getAnswers() {
  return new AnswerService(
    await getDatabase(),
    await getVectors(),
    chatProviderFromEnvironment(),
  );
}
