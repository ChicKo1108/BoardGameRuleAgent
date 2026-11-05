# 回答评测、人工复核与报告封存

本功能依赖 pi-answering，新增第八条 TypeORM 迁移。复用固定知识快照、不可变评测集与实际 AnswerService/Pi 执行链路，评估生成答案。只提供管理员后端接口，不包含产品前端。检索评测见 [12](12-retrieval-evaluations.md)，单题问答执行和预算见 [13](13-pi-answering.md)。

## 评测输入与可复现身份

使用已有 eval_datasets，明确选择 development 或 holdout。每题以 messages 的最后一条 user 消息作为问题，前面的消息作为固定历史。不会把人工标注的 query、requiredClaims、forbiddenClaims、acceptableEvidenceSets 或 expectedBehavior 发给 Agent，也不会用标准答案改写检索请求。历史最多 10 条、最后问题最多 2000 字符；不兼容的题目在入队前拒绝，不静默截断。

这是固定历史下的单轮回答评测：历史中的 assistant 回复由数据集提供，并非本次模型逐轮生成。不能据此宣称已经验证完整的自由多轮对话。holdout 是显式数据划分，单管理员仍能查看题目；隔离开发使用靠评测流程纪律，不宣称实现盲测权限系统。

每次实验固定数据集/知识 manifest hash、基础和向量索引、检索参数、模型 profile、提示词 hash、Pi/运行时/Node 版本及 APP_REVISION。identityHash 由 PostgreSQL 规范化 JSON 计算。Web 和 Worker 必须使用相同配置；运行前或结果写入时发现变化会中断实验，避免混入不同条件下的答案。模型版本标签不能证明供应商底层权重永远不变。

## 启动与接口

先执行数据库迁移和 queue:setup；配置 CHAT_*，hybrid/vector 还需与索引匹配的 EMBEDDING_*。以 `WORKER_TASKS=answer-evaluations npm run worker:start` 启动专用 Worker，也可与其他角色组合。未配置模型时拒绝执行，不返回伪造答案。下面均使用管理员 Bearer token；实际 schema 见 `/api/admin/openapi`。

| 方法与路径（前缀 /api/admin） | 作用 |
| --- | --- |
| POST /evaluation-datasets/{id}/answer-evaluations | 入队；idempotencyKey、config.split 和 config.retrieval |
| GET /answer-evaluations/{id} | 状态、配置身份、汇总、封存报告 |
| GET /answer-evaluations/{id}/cases | 分页题目、实际答案、自动结果和最新复核 |
| POST /answer-evaluations/{id}/retry | 恢复失败任务或丢失的队列记录 |
| POST /answer-evaluation-cases/{id}/reviews | 提交逐项复核；expectedRevision 与 review |
| GET /answer-evaluation-cases/{id}/reviews | 分页查看不可覆盖的复核历史 |
| POST /answer-evaluations/{id}/seal | 全部题目完成复核后封存；必填 note |

入队示例：

```json
{
  "idempotencyKey": "<新实验 UUID；请求重试复用>",
  "config": {
    "split": "development",
    "retrieval": {
      "indexBuildId": "<ready 基础索引 UUID>",
      "vectorIndexId": null,
      "mode": "lexical"
    }
  }
}
```

## 自动检查和人工判断

自动检查四项：运行完成且未因校验退回安全拒答；输出行为符合 answer/answer_with_assumption/clarify/abstain；从已保存的 context 事件重放引用校验并对比服务端来源；需要回答的题目至少引用一组完整的可接受证据。拒答/澄清题不计算证据组合覆盖率。验证失败导致的固定拒答不能因 expectedBehavior 恰好为 abstain 而算对。

自动检查不能判断引用是否在语义上支持结论。管理员逐题填写：

- conclusionCorrect：结论正确。
- conditionsAndExceptionsCorrect：条件和例外处理完整。
- ambiguityHandled：歧义/假设/确认符合题目；不适用时核对后填 true。
- refusalAppropriate：回答、澄清或拒答选择合理。
- citationsSupportClaims：引用在语义上支持结论。
- requiredClaimsSatisfied / forbiddenClaimsAbsent：按数据集顺序逐条判断，数组长度必须完全相同；空标注数组提交 []。
- note：解释审核依据或失败原因。

这些是单管理员的审核声明。代码不能证明提交者实际完成了人工阅读，不引入未经校准的 LLM 裁判替代审核。自动检查全部通过且所有人工项通过，题目才计入 passed；管理员不能通过手填 passed 绕过自动失败。

首次提交 expectedRevision=0；更正提交当前 revision，只追加新记录。过期 revision 返回 409；同一 revision 和相同内容的网络重试返回已保存记录。更正前后的结论、备注和时间均保留。复核、封存与并发更正在数据库父记录锁下串行处理。

## 指标和报告

正确率分母始终是所选 split 的全部题目。未生成、供应商失败、缺少复核都不能从分母中删除。按 category/severity 汇总，列出所有失败、关键失败和缺少复核的题号。运行失败数量与自动通过数量独立记录。没有适用题目时相应比率为 null，不制造 100%。

只有全部生成完成且每题至少有一条复核后才能 seal。报告绑定全部题目、实际 answerRunId、最终采用的 reviewId/revision、配置身份和汇总，数据库计算 reportHash；封存后实验、结果、审核和报告均不可覆盖。**包含失败的报告也可以封存，封存不等于达标或公众发布。** 发布门禁、质量阈值和公众版本指针在后续功能实现，不能把 sealed 状态当发布许可。

延迟来自持久化的单题问答起止时间，包含检索和生成，不含实验排队及人工审核时间。统计模型已报告 token、未知用量调用、无 usage 的题数以及配置费率估算。批次最多 100 题；每题沿用 AnswerService 的调用/时间/预估费用预算。计划模型预算可用题数乘以单题上限估算，但不包含查询 Embedding、基础设施费用，也不是供应商账单保证。当前没有独立批次/账户总额度控制。

## 中断与恢复

入队时为每题分配固定 executionKey，并存下规范化的问答输入。Worker 串行处理，每题结果独立提交。如果问答已经保存而评测尚未写入时崩溃，恢复复用原 answer_run，不重新调用模型。若旧问答仍在执行，等待原运行完成或到期；过期回收沿用 AnswerService。每题已失败答案也会保留；要重测需新实验，不能只重抽失败题来改善本次成绩。

这不承诺外部供应商 exactly-once 计费：请求已被供应商处理但本地崩溃时，实际用量可能未知；本系统不会用同一 executionKey 自动再次请求。已完成题目不可覆盖，旧 Worker 的 attempt token 不能提交到新尝试。队列缺失可显式恢复，已进入 awaiting_review/sealed 的实验不可重跑。

队列期限为 5 小时，Worker 协作式期限约 4 小时 43 分钟，覆盖最多 100 题的串行执行和恢复等待；单题仍受自身预算约束。队列基础设施错误最多自动重试两次；模型单题失败进入该题结果，继续处理其他题。部署应优雅停止 Worker，保留 PostgreSQL 队列和答案数据；Node/代码/模型配置升级后旧实验可能报告 RUNTIME_MISMATCH，需要保留原版本 Worker 恢复，或创建新实验。数据库查询的独立超时仍适用。

## 验证范围

自动化使用真实 PostgreSQL、pg-boss、Pi 和本地合成 SSE 服务，验证标签不泄漏、固定历史、版本范围、失败分母、人工更正、引用存在但结论错误、不可变封存、已保存答案复用、Worker 配置变化、旧尝试隔离及管理员鉴权。生产 HTTP 测试从 Next.js 入队，经独立 Worker 执行真实 Pi/混合检索，再提交合成复核并封存。

测试中的人工声明仅验证接口和计分行为，不是 Azul 质量结果。真实中文规则知识库审核、标准集标注、真实供应商运行和发布验收仍待完成。私有 PDF、密钥和真实未审核回答不进入仓库。
