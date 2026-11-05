# Pi 问答后端与管理员验收

本 PR 依赖 retrieval-evaluations，使用已安装并固定为 1.5.0 的 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`。实际 Agent 执行工具循环，供应商协议由 Pi 的 openai-completions 适配器处理；应用代码负责知识范围、预算、证据、输出和持久化。新增第七条 TypeORM 迁移。

目前是管理员同步验收接口，不是公众聊天入口。它允许管理员指定 ready 索引检查候选知识，不能跳过后续公众发布门禁。没有开发产品前端。

## 调用与身份

先按入库/检索文档生成 sealed 快照和 ready 索引。配置 `.env.example` 中 CHAT_*：base URL、服务端密钥、provider ID、model ID、版本标签、上下文上限、输入/输出美元每百万 token 费率。没有 CHAT_MODEL 返回 503 CHAT_NOT_CONFIGURED，不伪造模型结果。费率由部署者按供应商当前计费设置，不把代码中的固定数字当作实时价格。

使用 `POST /api/admin/answer-runs`（管理员 Bearer token）同步运行，HTTP 200 表示接口响应成功，必须检查返回的 state 和 answer.status：

```json
{
  "idempotencyKey": "<新问题使用新 UUID，网络重试复用原值>",
  "question": "从工厂拿花砖时，能只拿其中一部分吗？",
  "history": [],
  "retrieval": {
    "indexBuildId": "<ready 关键词索引 UUID>",
    "vectorIndexId": null,
    "mode": "lexical",
    "limit": 6,
    "candidateLimit": 20,
    "rrfK": 60,
    "maxRules": 20,
    "maxChars": 24000
  }
}
```

hybrid/vector 模式指定同一基础索引的 ready vectorIndexId；lexical 必须为 null。检索参数只能由本管理员接口选择，未来公众请求将由服务端发布配置提供。history 最多 10 条 user/assistant 文字消息，作为本次验收的上下文数据，不能传 system 或工具消息；历史答案不是证据。本阶段不保存公众会话，也尚未实现自动对话指代改写。

`GET /api/admin/answer-runs/{id}` 查看状态、输入、配置和结果；`GET /api/admin/answer-runs/{id}/events?limit=25&offset=0` 查看分页审计；实际结构见 OpenAPI。相同 key+规范化输入只启动一次，重复请求返回同一运行（并发时可能仍为 running），改变输入返回 409。即使服务失败，同 key 也不会自动重新消费模型；显式重测用新 key。

运行固定 release/index/vector 元组、索引配置 hash、Embedding profile hash、Chat profile、Pi/运行时/Node 版本、完整提示词及输出 schema 的 hash。部署时设置 APP_REVISION 记录实际 Git SHA；未设置时明确保存 null。供应商 model revision 是操作者标签，不能证明平台模型别名背后的权重永不变化；实际响应模型名也记录在事件里。

## 真实执行顺序

1. 写入 running 记录及管理员审计，再进行网络调用。
2. 服务端必需首轮 search + context，不由模型决定是否跳过；查询固定索引范围，读回完整规则、条件/例外及定位。
3. Pi 收到问题、历史数据和初始证据；可在预算内调用 search_rules({query}) 与 read_rule_context({chunkIds})。搜索返回最多 400 字符预览，不是引用依据。read 只接受本次搜索出现的 chunk ID，并由检索层再次约束索引。工具参数没有游戏、版本、URL、SQL 或命令执行入口。
4. 模型提出 JSON 答案；服务端校验结构、证据 ID、摘录及支持文字，必要时最多追加一次修正。修正轮禁止执行工具。校验仍失败返回固定 insufficient_evidence 正文；超时/供应商失败/预算耗尽返回 failed 和稳定 reasonCode，answer 为 null。
5. 最终状态及答案保存成功后才返回正文；没有向客户端输出未经校验的模型 token。

工具参数解析、模型请求和模型响应的关卡直接使用 Pi 的 hooks/subscription；错误/非法工具请求也计入工具次数。工具顺序执行，禁止超额并行消耗。提示词把问题、历史、来源文本与编辑注释视作数据；应用层权限和工具范围不依赖提示词服从性。

## 引用校验的实际范围

answered 必须有 basis（explicit/inferred/mixed）与引用。每条引用的 evidenceId 必须来自本次完整读取的证据；quote 必须是该规则 reviewed text 的连续片段（仅归一空白）；supports 必须出现在答案正文。模型不能提供页码或文档 URL：输出 schema 会拒绝这些额外属性，章节、documentId、blockId、PDF 页序号、印刷页码和坐标由服务端从快照补上。quote 引用经审核规则文字，不宣称逐字等同于原 PDF 文本。

有歧义必须同时给 ambiguity、assumedMeaning 和 followUp；这验证字段完备性，不证明解释是最可能的。任何已知关系缺口尚未补齐时禁止 answered；这是一项保守策略，可能因不相关关系产生过度拒答，需要真实数据校准。补充读取可消除已补齐的缺口。

needs_context 和 insufficient_evidence 的正文使用服务端固定措辞、清空规则裁定引用和 basis，保留模型给出的澄清/确认字段，防止将裁定藏在“不回答”状态的正文中。澄清字段本身仍需质量评测。

代码**不保证**摘录在语义上支持结论，也不能证明所有必要条件均已入库、模型没有忽略未引用的例外。模型没有输出内部思维过程；引用检查不是语义裁判。实际答案正确率、合理拒答率和歧义处理效果必须通过后续真实标准集、人工复核及生成评测验收。

## 预算与网络

默认每次运行：最多 4 次模型调用、4 个模型请求的工具调用（不含服务端首轮检索），每次最多 1500 输出 token、累计预留 6000 输出 token；每次输入序列化最多 96000 UTF-8 字节、累计 192000；新增证据累计 JSON 字符最多 64000；总协作式时限 60 秒。构造 AnswerService 时可使用 schema 限定范围内的服务端预算，HTTP 用户不能提高预算。

配置费率的预估费用默认预算 0.10 USD。每次调用前，用输入 UTF-8 字节数加消息开销作为保守 token 预留，并按最大输出 token 预留费用；额度不够则不发请求，不因供应商不返回 usage 放开预算。已返回用量另行汇总，未知用量明确计数，不当作免费。这个估算不是精确 tokenizer，不含查询 Embedding 和其他基础设施费用，也不等于实际账单或绝对费用保证。Embedding 请求次数由工具/运行预算约束，计费以供应商为准。

模型请求禁用 SDK 自动重试，每次 HTTP 超时 30 秒；运行总信号继续约束整个工具循环。base URL 仅由服务端配置，允许 HTTPS，HTTP 仅用于 loopback 测试；拒绝 URL 用户凭据、查询串和 fragment。只请求该 base 下的 /chat/completions，禁止重定向；响应流上限 1 MiB。API key 使用 JS 私有字段，不写入运行 profile、事件或错误正文。模型服务错误体不持久化，返回稳定错误码。

`thinkingLevel:off` 是 Pi 配置，不能保证所有兼容供应商默认关闭内部推理；模型特有开关仍需真实接入验收。实际输出截断、非法用量或超预算响应都不能发布为裁定。数据库查询受独立 15 秒 statement timeout 限制，AbortSignal 不会立即中断正在执行的 SQL；总时限是协作式时限。

## 持久化与故障

保存初始/补充查询、检索命中、证据包、工具完成状态、模型请求预算、响应 stopReason/模型名/用量、输出校验结果和最终答案。不会保存模型原始推理流、无效草稿或供应商错误体。问题、历史和已审核规则文本会保存在私有数据库中，管理员接口鉴权且 no-store；公众保留/删除策略后续实现。

记录与最终结果不可覆盖，事件按序追加。重复请求通过数据库锁和 idempotency key 防止并发重复执行；这不代表供应商计费 exactly-once。进程崩溃可发生在外部调用后、结果提交前，不能自动重做。到达运行时限加 30 秒宽限后，GET 会把遗留 running 标记 failed/ANSWER_RUN_EXPIRED，迟到事件/结果不可覆盖。当前没有独立过期清理 Worker，未访问的过期行保留 running 存储状态直到读取。

生产部署应允许同步请求至少覆盖预算与数据库收尾时间；本阶段未接客户端进度 SSE、异步聊天执行或 serverless 平台托管。发布治理已实现，见 [发布手册](15-knowledge-publication.md)；公众会话、身份额度、Sentry 和 Swagger UI 仍待完成。回答评测与人工复核已实现，见 [回答评测手册](14-answer-evaluations.md)；真实质量验收仍待完成。

## 已验证与待验证

自动测试使用真实 Pi 1.5.0 和本地模拟的 OpenAI-compatible SSE 服务，不是替换 Agent 实现。覆盖工具循环、恶意范围参数、猜测 chunk ID、错误引用一次修正、拒答正文保护、预算、超时、错误/超大/截断响应、缺失用量、数据库审计失败、幂等调用、知识范围、不可变审计和过期记录。生产 HTTP 测试通过 Next.js → PostgreSQL/pgvector → Pi → 本地 SSE 模型 → 引用校验 → 持久答案全链路。

TokenHub 的官方混元调用指南列出 /v1/chat/completions、SSE、include_usage 及 Function Calling，与当前适配方向一致；尚未使用真实账号调用，不能宣称所有 TokenHub 模型兼容或规则回答达标。当前未引入供应商特有响应格式强制参数，结构化输出由提示词/schema/修正校验实现。

参考：[TokenHub 混元调用指南](https://cloud.tencent.com/document/product/1823/132252)。Pi 行为以项目锁定版本的 node_modules/@earendil-works/pi-agent-core/README.md、dist/*.d.ts 及 pi-ai/api/openai-completions 实现核验。
