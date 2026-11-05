import { connectQueue } from "@boardgame/backend";
const state = globalThis as typeof globalThis & {
  boardgameQueue?: ReturnType<typeof connectQueue>;
};
export function getQueue() {
  if (!state.boardgameQueue) {
    state.boardgameQueue = connectQueue(process.env.DATABASE_URL ?? "");
    state.boardgameQueue.catch(() => {
      state.boardgameQueue = undefined;
    });
  }
  return state.boardgameQueue;
}
