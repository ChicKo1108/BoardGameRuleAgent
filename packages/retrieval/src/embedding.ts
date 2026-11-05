import { createHash } from "node:crypto";
import {
  vectorSchemas as v,
  type EmbeddingProfile,
} from "@boardgame/contracts";
export class EmbeddingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  embed(
    texts: string[],
    kind: "document" | "query",
    signal?: AbortSignal,
  ): Promise<{ vectors: number[][]; usageTokens: number | null }>;
}
export function validateVectors(
  vectors: unknown,
  count: number,
  dimensions: number,
): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count)
    throw new EmbeddingError("EMBEDDING_COUNT_MISMATCH");
  return vectors.map((vector) => {
    if (
      !Array.isArray(vector) ||
      vector.length !== dimensions ||
      vector.some(
        (n) =>
          typeof n !== "number" ||
          !Number.isFinite(n) ||
          !Number.isFinite(Math.fround(n)),
      )
    )
      throw new EmbeddingError("INVALID_EMBEDDING_VECTOR");
    const values = (vector as number[]).map(Math.fround);
    if (!values.some((n) => n !== 0))
      throw new EmbeddingError("ZERO_EMBEDDING_VECTOR");
    return values;
  });
}
export class CompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  private readonly endpoint: string;
  constructor(
    input: Omit<EmbeddingProfile, "endpointHash" | "protocol" | "distance"> & {
      endpoint: string;
      apiKey: string;
      timeoutMs?: number;
    },
  ) {
    const endpoint = new URL(input.endpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !(
        endpoint.protocol === "https:" ||
        (endpoint.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
      )
    )
      throw new EmbeddingError("INVALID_EMBEDDING_ENDPOINT");
    if (!input.apiKey) throw new EmbeddingError("EMBEDDING_KEY_REQUIRED");
    this.endpoint = endpoint.href;
    this.#apiKey = input.apiKey;
    this.timeoutMs = input.timeoutMs ?? 30000;
    const { apiKey, endpoint: ignored, timeoutMs, ...profile } = input;
    this.profile = Object.freeze(
      v.embeddingProfile.parse({
        ...profile,
        protocol: "openai-compatible-v1",
        distance: "cosine",
        endpointHash: createHash("sha256").update(this.endpoint).digest("hex"),
      }),
    );
  }
  readonly #apiKey: string;
  private readonly timeoutMs: number;
  async embed(
    texts: string[],
    kind: "document" | "query",
    signal?: AbortSignal,
  ) {
    if (texts.length < 1 || texts.length > 8)
      throw new EmbeddingError("EMBEDDING_BATCH_LIMIT");
    const prefix =
      kind === "query" ? this.profile.queryPrefix : this.profile.documentPrefix;
    const input = texts.map((text) => prefix + text);
    if (
      input.some(
        (text) => !text.trim() || text.length > this.profile.maxInputChars,
      )
    )
      throw new EmbeddingError("EMBEDDING_INPUT_LIMIT");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.profile.model,
          input,
          encoding_format: "float",
          ...(this.profile.sendDimensions
            ? { dimensions: this.profile.dimensions }
            : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new EmbeddingError(
          response.status === 429
            ? "EMBEDDING_RATE_LIMIT"
            : response.status >= 500
              ? "EMBEDDING_UNAVAILABLE"
              : "EMBEDDING_REQUEST_REJECTED",
        );
      }
      if (!response.body)
        throw new EmbeddingError("INVALID_EMBEDDING_RESPONSE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new EmbeddingError("EMBEDDING_RESPONSE_LIMIT");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (
        body.model !== this.profile.model ||
        !Array.isArray(body.data) ||
        body.data.length !== input.length
      )
        throw new EmbeddingError("INVALID_EMBEDDING_RESPONSE");
      const ordered: unknown[] = new Array(input.length);
      const seen = new Set<number>();
      for (const item of body.data) {
        if (
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= input.length ||
          seen.has(item.index)
        )
          throw new EmbeddingError("INVALID_EMBEDDING_RESPONSE");
        seen.add(item.index);
        ordered[item.index] = item.embedding;
      }
      const usageTokens = body.usage?.total_tokens ?? null;
      if (
        usageTokens !== null &&
        (!Number.isSafeInteger(usageTokens) ||
          usageTokens < 0 ||
          usageTokens > 2147483647)
      )
        throw new EmbeddingError("INVALID_EMBEDDING_USAGE");
      return {
        vectors: validateVectors(
          ordered,
          input.length,
          this.profile.dimensions,
        ),
        usageTokens,
      };
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (signal?.aborted) throw new EmbeddingError("EMBEDDING_ABORTED");
      if (timeout.aborted) throw new EmbeddingError("EMBEDDING_TIMEOUT");
      throw new EmbeddingError("EMBEDDING_TRANSPORT_ERROR");
    }
  }
}
export function embeddingProviderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider | undefined {
  if (!env.EMBEDDING_MODEL) return undefined;
  return new CompatibleEmbeddingProvider({
    endpoint: env.EMBEDDING_ENDPOINT ?? "",
    apiKey: env.EMBEDDING_API_KEY ?? "",
    providerId: env.EMBEDDING_PROVIDER_ID ?? "",
    model: env.EMBEDDING_MODEL,
    revision: env.EMBEDDING_REVISION ?? "",
    dimensions: Number(env.EMBEDDING_DIMENSIONS),
    sendDimensions: env.EMBEDDING_SEND_DIMENSIONS === "true",
    documentPrefix: env.EMBEDDING_DOCUMENT_PREFIX ?? "",
    queryPrefix: env.EMBEDDING_QUERY_PREFIX ?? "",
    maxInputChars: Number(env.EMBEDDING_MAX_INPUT_CHARS ?? 8000),
  });
}
