import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import {
  answeringSchemas as a,
  knowledgeSchemas as k,
  type VerifiedAnswer,
  type AnswerBudgets,
} from "@boardgame/contracts";
import { AnsweringError, failedStream, type ChatProvider } from "./provider.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
const searchView = k.searchResult.extend({
  tokens: z.array(z.string()).optional(),
  retrievalRunId: z.uuid().optional(),
  hits: z.array(
    k.searchResult.shape.hits.element.extend({
      preview: z
        .string()
        .max(800)
        .refine((value) => Array.from(value).length <= 400, "Preview too long"),
    }),
  ),
});
type Evidence = z.infer<typeof k.contextResult>["evidence"][number];
export interface RuleBindings {
  readonly scope: {
    releaseId: string;
    indexBuildId: string;
    rulesetId: string;
  };
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<z.infer<typeof searchView>>;
  context(
    chunkIds: string[],
    signal: AbortSignal,
  ): Promise<z.infer<typeof k.contextResult>>;
}
export type AgentRecord = { kind: string; data: unknown };
export interface RulesAgentInput {
  question: string;
  history: z.infer<typeof a.history>;
  provider: ChatProvider;
  bindings: RuleBindings;
  budgets?: Partial<AnswerBudgets>;
  signal?: AbortSignal;
  onRecord?: (record: AgentRecord) => Promise<void>;
}
const normal = (text: string) => text.replace(/\s+/gu, " ").trim();
export function verifyAnswer(
  raw: unknown,
  evidence: Map<string, Evidence>,
  unresolved: Set<string>,
): VerifiedAnswer {
  const parsed = a.answerDraft.safeParse(raw);
  if (!parsed.success) throw new AnsweringError("ANSWER_SCHEMA_INVALID");
  const draft = parsed.data;
  if (draft.status === "answered" && unresolved.size)
    throw new AnsweringError("INCOMPLETE_EVIDENCE");
  const citations = draft.citations.map((c) => {
    const source = evidence.get(c.evidenceId);
    if (!source) throw new AnsweringError("UNKNOWN_CITATION");
    if (!normal(source.text).includes(normal(c.quote)))
      throw new AnsweringError("QUOTE_NOT_IN_EVIDENCE");
    if (!normal(draft.answer).includes(normal(c.supports)))
      throw new AnsweringError("SUPPORT_NOT_IN_ANSWER");
    return {
      ...c,
      ruleId: source.ruleId,
      sectionPath: source.sectionPath,
      sources: source.sources,
    };
  });
  if (draft.status !== "answered")
    return a.verifiedAnswer.parse({
      ...draft,
      answer:
        draft.status === "needs_context"
          ? "还需要补充具体局面信息，才能给出裁定。"
          : refusal().answer,
      basis: null,
      citations: [],
    });
  return a.verifiedAnswer.parse({ ...draft, citations });
}
function refusal(): VerifiedAnswer {
  return {
    status: "insufficient_evidence",
    ambiguity: null,
    assumedMeaning: null,
    answer: "现有证据不足以给出经过核对的裁定。请补充具体操作或相关规则位置。",
    basis: null,
    citations: [],
    followUp: null,
  };
}
export async function runRulesAgent(input: RulesAgentInput) {
  const budget = a.budgets.parse(input.budgets ?? {});
  const signal = AbortSignal.any([
    AbortSignal.timeout(budget.timeoutMs),
    ...(input.signal ? [input.signal] : []),
  ]);
  const usage = {
    modelCalls: 0,
    toolCalls: 0,
    inputBytes: 0,
    outputTokensReserved: 0,
    reportedTokens: 0,
    unknownUsageCalls: 0,
    estimatedUsdReserved: 0,
    reportedTokenCostEstimateUsd: 0,
  };
  const evidence = new Map<string, Evidence>(),
    allowedChunks = new Set<string>(),
    gaps = new Set<string>();
  let evidenceChars = 0,
    answer: VerifiedAnswer | null = null,
    reasonCode: string | null = null,
    failure: string | null = null,
    repairUsed = false;
  const record = async (kind: string, data: unknown) => {
    await input.onRecord?.({ kind, data });
  };
  const checkScope = (data: { releaseId: string; indexBuildId: string }) => {
    if (
      data.releaseId !== input.bindings.scope.releaseId ||
      data.indexBuildId !== input.bindings.scope.indexBuildId
    )
      throw new AnsweringError("ANSWER_SCOPE_VIOLATION");
  };
  const search = async (query: string) => {
    signal.throwIfAborted();
    const result = searchView.parse(await input.bindings.search(query, signal));
    checkScope(result);
    for (const h of result.hits) allowedChunks.add(h.chunkId);
    await record("retrieval", { query, result });
    return result;
  };
  const read = async (chunkIds: string[]) => {
    signal.throwIfAborted();
    if (chunkIds.some((id) => !allowedChunks.has(id)))
      throw new AnsweringError("UNSEEN_CHUNK");
    const result = k.contextResult.parse(
      await input.bindings.context(chunkIds, signal),
    );
    checkScope(result);
    if (result.rulesetId !== input.bindings.scope.rulesetId)
      throw new AnsweringError("ANSWER_SCOPE_VIOLATION");
    const fresh = result.evidence.filter((e) => !evidence.has(e.evidenceId));
    const chars = JSON.stringify(fresh).length;
    if (evidenceChars + chars > budget.maxEvidenceChars)
      throw new AnsweringError("EVIDENCE_BUDGET_EXCEEDED");
    evidenceChars += chars;
    for (const e of result.evidence) evidence.set(e.evidenceId, e);
    for (const g of result.gaps) gaps.add(g.ruleId);
    for (const e of evidence.values()) gaps.delete(e.ruleId);
    await record("context", result);
    return result;
  };
  const searchArgs = z.strictObject({
    query: z.string().trim().min(1).max(2000),
  });
  const contextArgs = z.strictObject({
    chunkIds: z
      .array(z.uuid().toLowerCase())
      .min(1)
      .max(12)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate chunks"),
  });
  const safeTool = async (
    name: string,
    args: unknown,
    fn: () => Promise<unknown>,
  ) => {
    try {
      const result = await fn();
      await record("tool_result", { name, args, status: "succeeded" });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: { status: "succeeded" },
      };
    } catch (error) {
      if (signal.aborted) throw new AnsweringError("ANSWER_ABORTED");
      const errorCode =
        error instanceof AnsweringError ? error.code : "RETRIEVAL_TOOL_FAILED";
      await record("tool_result", { name, args, status: "failed", errorCode });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ errorCode }) },
        ],
        details: { errorCode },
        isError: true,
      };
    }
  };
  const tools: AgentTool[] = [
    {
      name: "search_rules",
      label: "检索规则",
      description:
        "在服务端固定的知识版本中检索。返回的 preview 仅供选择，必须读取上下文才能引用。",
      parameters: z.toJSONSchema(searchArgs),
      executionMode: "sequential",
      execute: async (_id, args) => {
        const v = searchArgs.parse(args);
        return safeTool("search_rules", v, () => search(v.query));
      },
    },
    {
      name: "read_rule_context",
      label: "读取规则和例外",
      description:
        "读取本次搜索命中的 chunkIds，包括相关条件、例外、完整文本和证据 ID。",
      parameters: z.toJSONSchema(contextArgs),
      executionMode: "sequential",
      execute: async (_id, args) => {
        const v = contextArgs.parse(args);
        return safeTool("read_rule_context", v, () => read(v.chunkIds));
      },
    },
  ];
  const agent = new Agent({
    initialState: {
      model: input.provider.model,
      systemPrompt: SYSTEM_PROMPT,
      tools,
      thinkingLevel: "off",
    },
    toolExecution: "sequential",
    identity: { attribution: null },
    streamFn: async (model, context, options) => {
      try {
        signal.throwIfAborted();
        const bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
        // UTF-8 bytes plus message overhead are a conservative reservation, not a tokenizer or bill.
        const reservedInputTokens = bytes + context.messages.length * 128;
        const reservedCost =
          (reservedInputTokens * input.provider.profile.inputUsdPerMillion +
            budget.maxOutputTokens *
              input.provider.profile.outputUsdPerMillion) /
          1000000;
        if (
          usage.modelCalls >= budget.maxModelCalls ||
          usage.outputTokensReserved + budget.maxOutputTokens >
            budget.maxTotalOutputTokens
        )
          throw new AnsweringError("MODEL_CALL_BUDGET_EXCEEDED");
        if (
          bytes > budget.maxInputBytes ||
          usage.inputBytes + bytes > budget.maxTotalInputBytes ||
          reservedInputTokens + budget.maxOutputTokens >
            input.provider.profile.contextWindow
        )
          throw new AnsweringError("MODEL_INPUT_BUDGET_EXCEEDED");
        if (usage.estimatedUsdReserved + reservedCost > budget.maxEstimatedUsd)
          throw new AnsweringError("MODEL_COST_BUDGET_EXCEEDED");
        await record("model_request", {
          call: usage.modelCalls + 1,
          inputBytes: bytes,
          maxOutputTokens: budget.maxOutputTokens,
          reservedCost,
        });
        usage.modelCalls++;
        usage.inputBytes += bytes;
        usage.outputTokensReserved += budget.maxOutputTokens;
        usage.estimatedUsdReserved += reservedCost;
        return await input.provider.stream(model, context, {
          ...options,
          signal,
          maxTokens: budget.maxOutputTokens,
        });
      } catch (error) {
        failure = signal.aborted
          ? "ANSWER_ABORTED"
          : error instanceof AnsweringError
            ? error.code
            : "MODEL_REQUEST_FAILED";
        return failedStream(model, failure);
      }
    },
    beforeToolCall: async () => {
      if (signal.aborted || failure || repairUsed)
        return {
          block: true,
          reason: "TOOL_EXECUTION_BLOCKED",
          terminate: true,
        };
      return undefined;
    },
    finishTurn: async ({ message }) => {
      if (message.role !== "assistant") return { action: "end" };
      if (
        failure ||
        signal.aborted ||
        ["error", "aborted", "length"].includes(message.stopReason)
      ) {
        failure ??= signal.aborted
          ? "ANSWER_ABORTED"
          : message.stopReason === "length"
            ? "MODEL_OUTPUT_TRUNCATED"
            : "CHAT_PROVIDER_ERROR";
        return { action: "end" };
      }
      if (message.content.some((c) => c.type === "toolCall")) {
        if (repairUsed) {
          answer = refusal();
          reasonCode = "ANSWER_REPAIR_FAILED";
          return { action: "end" };
        }
        return undefined;
      }
      try {
        const text = message.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        if (text.length > 16000) throw new AnsweringError("ANSWER_TOO_LARGE");
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new AnsweringError("ANSWER_JSON_INVALID");
        }
        answer = verifyAnswer(raw, evidence, gaps);
        await record("answer_validation", { valid: true });
        return { action: "end" };
      } catch (error) {
        const errorCode =
          error instanceof AnsweringError
            ? error.code
            : "ANSWER_VALIDATION_FAILED";
        await record("answer_validation", { valid: false, errorCode });
        if (!repairUsed && usage.modelCalls < budget.maxModelCalls) {
          repairUsed = true;
          agent.followUp({
            role: "user",
            content: `服务端校验失败：${errorCode}。仅修正最终 JSON；不得调用工具。若无法用已读取的完整证据支持结论，返回 insufficient_evidence。`,
            timestamp: Date.now(),
          });
          return { action: "continue" };
        }
        answer = refusal();
        reasonCode = errorCode;
        return { action: "end" };
      }
    },
  });
  agent.subscribe(async (event) => {
    if (event.type === "tool_execution_end") {
      await record("tool_completion", {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
        durationMs: event.durationMs ?? null,
      });
      return;
    }
    if (event.type !== "message_end" || event.message.role !== "assistant")
      return;
    // Budget/preflight failures are synthetic Pi messages, not provider responses.
    if (failure) return;
    const message = event.message;
    const u = message.usage;
    if (
      !Number.isSafeInteger(u.totalTokens) ||
      u.totalTokens < 0 ||
      u.totalTokens >
        input.provider.profile.contextWindow + budget.maxOutputTokens ||
      ![u.input, u.output, u.cacheRead, u.cacheWrite].every(
        (n) =>
          Number.isSafeInteger(n) &&
          n >= 0 &&
          n <= input.provider.profile.contextWindow + budget.maxOutputTokens,
      )
    ) {
      failure = "INVALID_MODEL_USAGE";
      usage.unknownUsageCalls++;
      agent.abort();
      return;
    }
    usage.reportedTokens += u.totalTokens;
    if (u.totalTokens === 0) usage.unknownUsageCalls++;
    usage.reportedTokenCostEstimateUsd +=
      ((u.input + u.cacheRead + u.cacheWrite) *
        input.provider.profile.inputUsdPerMillion +
        u.output * input.provider.profile.outputUsdPerMillion) /
      1000000;
    const toolCalls = message.content.filter((c) => c.type === "toolCall");
    usage.toolCalls += toolCalls.length;
    await record("model_response", {
      call: usage.modelCalls,
      stopReason: message.stopReason,
      responseModel: message.responseModel ?? message.model,
      usage: {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        totalTokens: u.totalTokens,
      },
      toolCalls: toolCalls.map((c) => ({ name: c.name, id: c.id })),
    });
    if (usage.toolCalls > budget.maxToolCalls) {
      failure = "TOOL_CALL_BUDGET_EXCEEDED";
      agent.abort();
    }
    if (
      u.output > budget.maxOutputTokens ||
      usage.reportedTokenCostEstimateUsd > budget.maxEstimatedUsd
    ) {
      failure = "MODEL_USAGE_BUDGET_EXCEEDED";
      agent.abort();
    }
  });
  const abort = () => agent.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const initial = await search(input.question);
    const context = initial.hits.length
      ? await read(initial.hits.map((h) => h.chunkId))
      : null;
    await agent.prompt(
      JSON.stringify({
        question: input.question,
        history: input.history,
        initialSearch: initial,
        initialContext: context,
      }),
    );
    if (signal.aborted) failure ??= "ANSWER_ABORTED";
    if (failure)
      return {
        state: "failed" as const,
        answer: null,
        reasonCode: failure,
        usage,
      };
    return {
      state: "completed" as const,
      answer: answer ?? refusal(),
      reasonCode: reasonCode ?? (answer ? null : "NO_VALID_ANSWER"),
      usage,
    };
  } catch (error) {
    return {
      state: "failed" as const,
      answer: null,
      reasonCode: signal.aborted
        ? "ANSWER_ABORTED"
        : error instanceof AnsweringError
          ? error.code
          : "ANSWER_INFRASTRUCTURE_ERROR",
      usage,
    };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
