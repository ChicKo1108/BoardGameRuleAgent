import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  runRulesAgent,
  verifyAnswer,
  CompatibleChatProvider,
  type RuleBindings,
  type AgentRecord,
} from "../packages/agent/src/index.ts";
import { chatServer, validDraft, lastEvidence } from "./helpers/chat.js";
function fixtures() {
  const releaseId = randomUUID(),
    indexBuildId = randomUUID(),
    rulesetId = randomUUID(),
    chunkId = randomUUID(),
    ruleId = randomUUID();
  const evidence = {
    evidenceId: ruleId,
    ruleId,
    kind: "rule",
    role: "primary" as const,
    text: "合成测试规则：拿取工厂同色的全部花砖。",
    sectionPath: ["合成规则"],
    applicability: [],
    editorialExplanation: "编辑备注，不是规则原文",
    sources: [
      {
        blockId: randomUUID(),
        documentId: randomUUID(),
        documentTitle: "合成测试",
        sourceType: "rulebook",
        pdfPageIndex: 2,
        printedPageLabel: "3",
        bbox: null,
      },
    ],
  };
  const calls: { name: string; value: unknown }[] = [];
  const bindings: RuleBindings = {
    scope: { releaseId, indexBuildId, rulesetId },
    search: async (query) => {
      calls.push({ name: "search", value: query });
      return {
        releaseId,
        indexBuildId,
        query,
        tokens: [query],
        hits: [{ chunkId, ruleId, rank: 1, score: 1, preview: evidence.text }],
      };
    },
    context: async (ids) => {
      calls.push({ name: "context", value: ids });
      return {
        releaseId,
        indexBuildId,
        rulesetId,
        evidence: [evidence],
        relations: [],
        gaps: [],
      };
    },
  };
  return { bindings, evidence, calls, chunkId };
}
test("real Pi and SSE adapter answer only after mandatory retrieval, with canonical citations and no reasoning logs", async () => {
  const http = await chatServer((body) => ({
    text: JSON.stringify(validDraft(body)),
    thinking: "private reasoning not to persist",
  }));
  try {
    const f = fixtures(),
      records: AgentRecord[] = [];
    const result = await runRulesAgent({
      question: "拿几块？",
      history: [],
      provider: http.provider,
      bindings: f.bindings,
      onRecord: async (r) => {
        records.push(r);
      },
    });
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert.equal(result.answer!.status, "answered");
    assert.equal(result.answer!.citations[0].sources[0].pdfPageIndex, 2);
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(result.usage.reportedTokens, 150);
    assert.deepEqual(
      records.slice(0, 3).map((r) => r.kind),
      ["retrieval", "context", "model_request"],
    );
    assert.ok(!JSON.stringify(records).includes("private reasoning"));
    assert.ok(!JSON.stringify(http.provider).includes("synthetic-chat-secret"));
    assert.equal(http.requests[0].max_tokens, 1500);
    assert.equal(http.requests[0].messages[0].role, "system");
    assert.deepEqual(
      http.requests[0].tools.map((t: any) => t.function.name),
      ["search_rules", "read_rule_context"],
    );
  } finally {
    await http.close();
  }
});
test("Pi performs supplemental search then scoped context read before answering", async () => {
  const f = fixtures();
  const http = await chatServer((body, call) =>
    call === 1
      ? { tools: [{ name: "search_rules", arguments: { query: "工厂同色" } }] }
      : call === 2
        ? {
            tools: [
              {
                name: "read_rule_context",
                arguments: { chunkIds: [f.chunkId] },
              },
            ],
          }
        : { text: JSON.stringify(validDraft(body)) },
  );
  try {
    const result = await runRulesAgent({
      question: "拿几块？",
      history: [],
      provider: http.provider,
      bindings: f.bindings,
    });
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert.equal(result.answer!.status, "answered");
    assert.equal(result.usage.modelCalls, 3);
    assert.equal(result.usage.toolCalls, 2);
    assert.deepEqual(
      f.calls.map((c) => c.name),
      ["search", "context", "search", "context"],
    );
  } finally {
    await http.close();
  }
});
test("invalid citations get one targeted repair and repeated invalid output becomes a safe refusal", async () => {
  for (const repaired of [true, false]) {
    const http = await chatServer((body, call) => {
      const draft = validDraft(body);
      if (!repaired || call === 1) draft.citations[0].evidenceId = randomUUID();
      return { text: JSON.stringify(draft) };
    });
    try {
      const f = fixtures();
      const result = await runRulesAgent({
        question: "规则？",
        history: [],
        provider: http.provider,
        bindings: f.bindings,
      });
      assert.equal(result.state, "completed");
      assert.equal(http.requests.length, 2);
      assert.equal(
        result.answer!.status,
        repaired ? "answered" : "insufficient_evidence",
      );
      if (!repaired) assert.equal(result.answer!.citations.length, 0);
    } finally {
      await http.close();
    }
  }
});
test("citation validation rejects fabricated locations, editorial quotes, unrelated supports, and missing ambiguity fields", () => {
  const f = fixtures(),
    map = new Map([[f.evidence.evidenceId, f.evidence]]);
  const draft = {
    status: "answered",
    ambiguity: null,
    assumedMeaning: null,
    answer: "全部拿走。",
    basis: "explicit",
    citations: [
      {
        evidenceId: f.evidence.evidenceId,
        quote: f.evidence.text,
        supports: "全部拿走。",
      },
    ],
    followUp: null,
  };
  assert.equal(verifyAnswer(draft, map, new Set()).status, "answered");
  assert.throws(
    () =>
      verifyAnswer(
        { ...draft, citations: [{ ...draft.citations[0], page: 99 }] },
        map,
        new Set(),
      ),
    /ANSWER_SCHEMA_INVALID/,
  );
  assert.throws(
    () =>
      verifyAnswer(
        {
          ...draft,
          citations: [
            { ...draft.citations[0], quote: f.evidence.editorialExplanation },
          ],
        },
        map,
        new Set(),
      ),
    /QUOTE_NOT_IN_EVIDENCE/,
  );
  assert.throws(
    () =>
      verifyAnswer(
        {
          ...draft,
          citations: [{ ...draft.citations[0], supports: "没有限制" }],
        },
        map,
        new Set(),
      ),
    /SUPPORT_NOT_IN_ANSWER/,
  );
  assert.throws(
    () =>
      verifyAnswer({ ...draft, ambiguity: "操作阶段不明确" }, map, new Set()),
    /ANSWER_SCHEMA_INVALID/,
  );
  assert.throws(
    () => verifyAnswer(draft, map, new Set([randomUUID()])),
    /INCOMPLETE_EVIDENCE/,
  );
  const clarified = verifyAnswer(
    {
      ...draft,
      ambiguity: "可能指拿取或补充阶段",
      assumedMeaning: "按拿取阶段理解",
      followUp: "你指的是拿取阶段吗？",
    },
    map,
    new Set(),
  );
  assert.ok(clarified.followUp);
});
test("foreign or unsearched chunks cannot reach retrieval tools and version override parameters are rejected", async () => {
  for (const args of [
    { chunkIds: [randomUUID()] },
    { chunkIds: [randomUUID()], releaseId: randomUUID() },
  ]) {
    const f = fixtures();
    const http = await chatServer((body, call) =>
      call === 1
        ? { tools: [{ name: "read_rule_context", arguments: args }] }
        : { text: JSON.stringify(validDraft(body)) },
    );
    try {
      const result = await runRulesAgent({
        question: "规则",
        history: [],
        provider: http.provider,
        bindings: f.bindings,
      });
      assert.equal(result.state, "completed");
      assert.equal(f.calls.filter((c) => c.name === "context").length, 1);
      assert.equal(result.usage.toolCalls, 1);
    } finally {
      await http.close();
    }
  }
});
test("request, tool, input and estimated cost budgets stop actual provider calls", async () => {
  const scenarios = [
    {
      budget: { maxModelCalls: 2, maxToolCalls: 8 },
      expected: "MODEL_CALL_BUDGET_EXCEEDED",
      calls: 2,
    },
    {
      budget: { maxToolCalls: 0 },
      expected: "TOOL_CALL_BUDGET_EXCEEDED",
      calls: 1,
    },
    {
      budget: { maxInputBytes: 1000 },
      expected: "MODEL_INPUT_BUDGET_EXCEEDED",
      calls: 0,
    },
    {
      budget: { maxEstimatedUsd: 0.000001 },
      expected: "MODEL_COST_BUDGET_EXCEEDED",
      calls: 0,
    },
  ];
  for (const s of scenarios) {
    const f = fixtures();
    const http = await chatServer(() => ({
      tools: [{ name: "search_rules", arguments: { query: "规则" } }],
    }));
    try {
      const result = await runRulesAgent({
        question: "规则",
        history: [],
        provider: http.provider,
        bindings: f.bindings,
        budgets: s.budget,
      });
      assert.equal(result.state, "failed");
      assert.equal(result.reasonCode, s.expected);
      assert.equal(http.requests.length, s.calls);
      assert.equal(result.usage.unknownUsageCalls, 0);
      assert.equal(result.answer, null);
    } finally {
      await http.close();
    }
  }
});
test("timeout and caller cancellation abort the model without returning an unchecked answer", async () => {
  const http = await chatServer(async (body) => {
    await new Promise((r) => setTimeout(r, 250));
    return { text: JSON.stringify(validDraft(body)) };
  });
  try {
    const f = fixtures();
    const timed = await runRulesAgent({
      question: "规则",
      history: [],
      provider: http.provider,
      bindings: f.bindings,
      budgets: { timeoutMs: 100 },
    });
    assert.equal(timed.state, "failed");
    assert.equal(timed.reasonCode, "ANSWER_ABORTED");
    const controller = new AbortController();
    controller.abort();
    const before = http.requests.length;
    const cancelled = await runRulesAgent({
      question: "规则",
      history: [],
      provider: http.provider,
      bindings: f.bindings,
      signal: controller.signal,
    });
    assert.equal(cancelled.reasonCode, "ANSWER_ABORTED");
    assert.equal(http.requests.length, before);
  } finally {
    await http.close();
  }
});
test("unknown usage remains explicit; oversized, failed, truncated and over-budget responses never become answers", async () => {
  for (const kind of ["unknown", "http", "oversized", "truncated", "usage"]) {
    const http = await chatServer((body) =>
      kind === "http"
        ? { status: 500, body: "private-provider-secret" }
        : kind === "oversized"
          ? { text: "x".repeat(1100000) }
          : {
              text: JSON.stringify(validDraft(body)),
              ...(kind === "unknown"
                ? { usage: null }
                : kind === "truncated"
                  ? { finish: "length" }
                  : {
                      usage: {
                        prompt_tokens: 100,
                        completion_tokens: 9999,
                        total_tokens: 10099,
                      },
                    }),
            },
    );
    try {
      const f = fixtures(),
        records: AgentRecord[] = [];
      const result = await runRulesAgent({
        question: "规则",
        history: [],
        provider: http.provider,
        bindings: f.bindings,
        onRecord: async (r) => {
          records.push(r);
        },
      });
      assert.equal(
        result.state,
        kind === "unknown" ? "completed" : "failed",
        JSON.stringify(result),
      );
      if (kind === "unknown") assert.equal(result.usage.unknownUsageCalls, 1);
      else assert.equal(result.answer, null);
      assert.ok(
        !JSON.stringify({ result, records }).includes(
          "private-provider-secret",
        ),
      );
    } finally {
      await http.close();
    }
  }
});
test("scope corruption fails before model access and unresolved related-rule gaps block a ruling", async () => {
  const f = fixtures(),
    http = await chatServer();
  try {
    const original = f.bindings.context;
    f.bindings.context = async (ids, signal) => ({
      ...(await original(ids, signal)),
      releaseId: randomUUID(),
    });
    const bad = await runRulesAgent({
      question: "规则",
      history: [],
      provider: http.provider,
      bindings: f.bindings,
    });
    assert.equal(bad.reasonCode, "ANSWER_SCOPE_VIOLATION");
    assert.equal(http.requests.length, 0);
    f.bindings.context = async (ids, signal) => ({
      ...(await original(ids, signal)),
      gaps: [{ code: "RELATED_RULE_OMITTED", ruleId: randomUUID() }],
    });
    const gap = await runRulesAgent({
      question: "规则",
      history: [],
      provider: http.provider,
      bindings: f.bindings,
    });
    assert.equal(gap.answer!.status, "insufficient_evidence");
    assert.equal(gap.reasonCode, "INCOMPLETE_EVIDENCE");
  } finally {
    await http.close();
  }
});

test("refusal or clarification status cannot smuggle an uncited ruling into the answer body", () => {
  const f = fixtures(),
    map = new Map([[f.evidence.evidenceId, f.evidence]]);
  for (const status of ["insufficient_evidence", "needs_context"]) {
    const answer = verifyAnswer(
      {
        status,
        ambiguity: null,
        assumedMeaning: null,
        answer: "你必须弃掉全部花砖！",
        basis: "explicit",
        citations: [],
        followUp: "你指哪个阶段？",
      },
      map,
      new Set(),
    );
    assert.ok(!answer.answer.includes("弃掉"));
    assert.equal(answer.basis, null);
    assert.deepEqual(answer.citations, []);
  }
});
test("audit failure stops the request before model access", async () => {
  const http = await chatServer();
  try {
    const f = fixtures();
    const result = await runRulesAgent({
      question: "规则",
      history: [],
      provider: http.provider,
      bindings: f.bindings,
      onRecord: async () => {
        throw new Error("private database details");
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.reasonCode, "ANSWER_INFRASTRUCTURE_ERROR");
    assert.equal(http.requests.length, 0);
  } finally {
    await http.close();
  }
});
