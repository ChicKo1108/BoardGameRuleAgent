import { AnswerEvaluationService } from "@boardgame/backend";
import { getDatabase } from "./database";
import { getQueue } from "./queue";
import { getAnswers } from "./answers";
export async function getAnswerEvaluations() {
  return new AnswerEvaluationService(
    await getDatabase(),
    await getQueue(),
    await getAnswers(),
  );
}
