import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { CompatibleEmbeddingProvider } from "../../packages/retrieval/src/index.ts";
export async function embeddingServer(
  respond?: (body: any) => unknown | Promise<unknown>,
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      requests.push(body);
      const output = respond
        ? await respond(body)
        : {
            model: body.model,
            data: body.input
              .map((text: string, index: number) => ({
                index,
                embedding:
                  text.includes("地板") || text.includes("跌落")
                    ? [0, 1, 0]
                    : text.includes("工厂")
                      ? [1, 0, 0]
                      : [0, 0, 1],
              }))
              .reverse(),
            usage: { total_tokens: body.input.length * 10 },
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(typeof output === "string" ? output : JSON.stringify(output));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/embeddings`;
  const config = {
    endpoint,
    apiKey: "synthetic-test-key",
    providerId: "synthetic-http",
    model: "synthetic-embedding",
    revision: "fixture-v1",
    dimensions: 3,
    sendDimensions: false,
    documentPrefix: "",
    queryPrefix: "",
    maxInputChars: 8000,
  };
  return {
    endpoint,
    config,
    provider: new CompatibleEmbeddingProvider(config),
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
