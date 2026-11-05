import { createServer } from "node:http";
import { CompatibleChatProvider } from "../../packages/agent/src/index.ts";
export function contentText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => c.text ?? "").join("")
      : "";
}
export function lastEvidence(body: any): any {
  for (const m of [...body.messages].reverse()) {
    try {
      const data = JSON.parse(contentText(m.content));
      if (data.evidence?.length) return data.evidence[0];
      if (data.initialContext?.evidence?.length)
        return data.initialContext.evidence[0];
    } catch {}
  }
  return null;
}
export function validDraft(body: any) {
  const e = lastEvidence(body);
  return e
    ? {
        status: "answered",
        ambiguity: null,
        assumedMeaning: null,
        answer: "按这条规则执行。",
        basis: "explicit",
        citations: [
          {
            evidenceId: e.evidenceId,
            quote: e.text,
            supports: "按这条规则执行。",
          },
        ],
        followUp: null,
      }
    : {
        status: "insufficient_evidence",
        ambiguity: null,
        assumedMeaning: null,
        answer: "没有找到足够证据。",
        basis: null,
        citations: [],
        followUp: null,
      };
}
export type ChatReply = {
  text?: string;
  tools?: Array<{ name: string; arguments: unknown }>;
  status?: number;
  body?: string;
  thinking?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  finish?: string;
};
export async function chatServer(
  reply: (body: any, call: number) => ChatReply | Promise<ChatReply> = (
    body,
  ) => ({ text: JSON.stringify(validDraft(body)) }),
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      let data = "";
      for await (const chunk of req) data += String(chunk);
      const body = JSON.parse(data);
      requests.push(body);
      const output = await reply(body, requests.length);
      if (output.status) {
        res.writeHead(output.status);
        res.end(output.body ?? "provider error");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "synthetic-response", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      chunk({ role: "assistant" });
      if (output.thinking) chunk({ reasoning_content: output.thinking });
      if (output.tools)
        chunk({
          tool_calls: output.tools.map((t, index) => ({
            index,
            id: `tool-${requests.length}-${index}`,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.arguments) },
          })),
        });
      if (output.text) chunk({ content: output.text });
      chunk({}, output.finish ?? (output.tools ? "tool_calls" : "stop"));
      const usage =
        output.usage === undefined
          ? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
          : output.usage;
      if (usage)
        res.write(
          `data: ${JSON.stringify({ id: "synthetic-response", object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    } catch {
      res.writeHead(500);
      res.end("synthetic failure");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const config = {
    baseUrl,
    apiKey: "synthetic-chat-secret",
    providerId: "synthetic-chat",
    model: "synthetic-rules-model",
    revision: "test-v1",
    contextWindow: 131072,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  };
  return {
    config,
    requests,
    provider: new CompatibleChatProvider(config),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
