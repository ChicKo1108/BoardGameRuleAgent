import { createHash } from "node:crypto";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  answeringSchemas as a,
  type ChatModelProfile,
} from "@boardgame/contracts";
export interface ChatProvider {
  readonly profile: ChatModelProfile;
  readonly model: Model<"openai-completions">;
  readonly stream: StreamFn;
}
export class AnsweringError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function failedStream(model: Model<any>, code: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "error",
    errorMessage: code,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}
export class CompatibleChatProvider implements ChatProvider {
  readonly profile: ChatModelProfile;
  readonly model: Model<"openai-completions">;
  readonly #apiKey: string;
  readonly #endpoint: string;
  constructor(
    input: Omit<ChatModelProfile, "protocol" | "endpointHash"> & {
      baseUrl: string;
      apiKey: string;
    },
  ) {
    const url = new URL(input.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new AnsweringError("INVALID_CHAT_ENDPOINT");
    if (!input.apiKey) throw new AnsweringError("CHAT_KEY_REQUIRED");
    const baseUrl = url.href.replace(/\/$/, "");
    this.#endpoint = baseUrl + "/chat/completions";
    this.#apiKey = input.apiKey;
    const { baseUrl: _, apiKey: __, ...profile } = input;
    this.profile = Object.freeze(
      a.modelProfile.parse({
        ...profile,
        protocol: "pi-openai-completions-v1",
        endpointHash: createHash("sha256").update(baseUrl).digest("hex"),
      }),
    );
    this.model = Object.freeze({
      id: input.model,
      name: input.model,
      api: "openai-completions",
      provider: input.providerId,
      baseUrl,
      input: ["text"],
      reasoning: false,
      contextWindow: input.contextWindow,
      maxTokens: 4096,
      cost: {
        input: input.inputUsdPerMillion,
        output: input.outputUsdPerMillion,
        cacheRead: input.inputUsdPerMillion,
        cacheWrite: input.inputUsdPerMillion,
      },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    } as Model<"openai-completions">);
  }
  private fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== this.#endpoint)
      throw new AnsweringError("CHAT_ENDPOINT_MISMATCH");
    const response = await fetch(input, { ...init, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AnsweringError(
        response.status === 429
          ? "CHAT_RATE_LIMIT"
          : "CHAT_PROVIDER_HTTP_ERROR",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AnsweringError("CHAT_EMPTY_RESPONSE");
    let size = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          size += next.value.byteLength;
          if (size > 1024 * 1024) {
            await reader.cancel();
            controller.error(new AnsweringError("CHAT_RESPONSE_TOO_LARGE"));
            return;
          }
          controller.enqueue(next.value);
        } catch {
          controller.error(new AnsweringError("CHAT_STREAM_ERROR"));
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  };
  readonly stream: StreamFn = (_model, context, options) => {
    try {
      return streamSimple(this.model, context, {
        ...options,
        apiKey: this.#apiKey,
        fetch: this.fetch,
        maxRetries: 0,
        timeoutMs: 30000,
        cacheRetention: "none",
        temperature: 0,
        transport: "sse",
      });
    } catch {
      return failedStream(this.model, "CHAT_PROVIDER_ERROR");
    }
  };
}
export function chatProviderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ChatProvider | undefined {
  if (!env.CHAT_MODEL) return undefined;
  const required = (key: string) => {
    if (!env[key]) throw new AnsweringError("CHAT_CONFIG_REQUIRED_" + key);
    return env[key]!;
  };
  return new CompatibleChatProvider({
    baseUrl: required("CHAT_BASE_URL"),
    apiKey: required("CHAT_API_KEY"),
    providerId: required("CHAT_PROVIDER_ID"),
    model: env.CHAT_MODEL,
    revision: required("CHAT_MODEL_REVISION"),
    contextWindow: Number(required("CHAT_CONTEXT_WINDOW")),
    inputUsdPerMillion: Number(required("CHAT_INPUT_USD_PER_MILLION")),
    outputUsdPerMillion: Number(required("CHAT_OUTPUT_USD_PER_MILLION")),
  });
}
