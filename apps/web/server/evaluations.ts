import { EvaluationService } from "@boardgame/backend";
import { getDatabase } from "./database";
import { getQueue } from "./queue";
import { getVectors } from "./vectors";
export async function getEvaluations() {
  return new EvaluationService(
    await getDatabase(),
    await getQueue(),
    await getVectors(),
  );
}
