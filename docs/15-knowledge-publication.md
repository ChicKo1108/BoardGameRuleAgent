# 知识发布门禁、切换与回滚

依赖 answer-evaluations，新增第九条 TypeORM 迁移。知识快照 sealed、回答评测 sealed 和公众激活是三件不同的事。本功能增加不可变发布策略、门禁结果、完整发布清单，以及按 ruleset 隔离的当前版本指针和切换历史。所有接口需管理员鉴权；没有新增产品前端或公众聊天接口。

## 一次发布的顺序

1. 完成知识审核、快照、ready 索引和人工标注的数据集。数据集必须有 holdout；development 只能用于开发评测。
2. 读取当前指针 revision，创建 policy，明确题量/分类/关键题下限、正确率与完整证据率，并记录理由。策略绑定该数据集、当前指针及回归基线，创建后不可修改。
3. 在策略创建后启动相同数据集的 holdout 检索评测和回答评测。模型、提示词、索引、候选数、最终召回数、关联补全预算必须对齐。检索评测 context 不得为空。
4. 完成逐题人工复核并封存回答报告。生成失败、关键错误和未复核题目不能丢弃。
5. POST /publications 生成不可变门禁结果。未达标会保存 passed=false 与失败原因，不移动任何指针；未完成、跨版本、参数不匹配或事后制定策略直接拒绝请求。
6. 管理员检查门禁/报告后，显式提交 publish 转换，提供 expectedRevision、操作 UUID 和 note。没有 force 参数。应用检查当前运行环境后，在同一事务中插入事件、更新指针和写审计。

策略先于两个评测运行的创建时间，由 PostgreSQL 时间比较保证。不能在看到这两份结果后降低阈值直接发布；新策略要求新的两份评测。单管理员仍能反复选数据、试模型或修改供应商别名，因此这不是统计盲测或独立审核证明。

## 策略与不可降低的检查

minCorrectRate 和 minEvidenceCompleteRate 必填，不默认把 95% 当成已批准标准。minCases 至少 6、minCriticalCases 至少 1，五个分类各至少 1 题，均可提高。下面只是配置示例，正式值应在真实标准集验收前明确：

```json
{
  "idempotencyKey": "<策略 UUID>",
  "datasetId": "<同规则集候选知识的数据集 UUID>",
  "expectedRevision": 0,
  "config": {
    "minCases": 24,
    "minCriticalCases": 4,
    "minimumByCategory": {
      "recall": 4,
      "ambiguity": 4,
      "inference": 4,
      "multi_turn": 4,
      "insufficient_evidence": 4
    },
    "minCorrectRate": 0.95,
    "minEvidenceCompleteRate": 0.95
  },
  "note": "说明本次验收范围与阈值依据"
}
```

六题是避免空门禁的结构下限，绝不是商业质量充分样本。当前数据集上限 100 题，且不支持跨数据集聚合发布验收；扩大样本时需后续扩展，不可用六道合成题代表 Azul 达标。

固定检查：

- 必须覆盖 answer、answer_with_assumption、clarify、abstain；multi_turn 至少包含一条历史 assistant 消息。类别和行为标注由管理员负责核对。
- 回答结果全部完成、全部复核；运行失败为零，关键题全部通过，引用完整性校验率为 100%。正确率包含自动检查和人工语义复核结果。
- 检索评测无失败/待执行题，包含可计算的完整上下文证据率；关键且有证据标注的题目不得遗漏完整证据组合。
- 同知识、同数据集、同索引及完整检索参数；数据/知识/索引/Embedding/Node 身份对齐。
- 回答评测必须记录 40 位完整 Git 提交号 APP_REVISION。发布、回滚和运行解析时，当前模型/预算/提示词/Pi/Node/APP_REVISION 等必须与评测记录一致；向量模式还必须实际配置与索引匹配的 Embedding provider。
- 当前基线中已通过的题目不得退步。阈值较低也不能覆盖这些阻断项。

引用完整性仍不是语义支持证明；语义来自所绑定的人工复核。运行版本来自部署注入的 APP_REVISION，系统检查其格式与一致性，不验证构建供应链签名。生产流水线必须注入实际部署提交，不可复用虚假标签。供应商 model revision 是标签，不证明远程权重永远不变。

## 回归基线与知识变更

策略保存 baselinePublicationId/baselineRevision 用于并发检查，另保存 regressionPublicationId 指向最近一次实际激活的版本。停用会将当前指针置空，但不会清空回归基线；重新制定策略仍需与该基线比较。

按稳定 case ID 对齐所有旧 holdout 题。问题/固定历史、检索标准查询、类别、严重性、预期行为和答案要点必须保持可比较；允许新知识版本重新映射 acceptableEvidenceSets 的规则 UUID，且映射仍需人工审核。不允许删除旧题、重命名或改变标准后默认为通过；返回 REGRESSION_SUITE_CHANGED。旧通过题变失败返回 ANSWER_REGRESSION，可新增题目扩大覆盖。

该比较是已保存结果之间的回归，不自动重跑旧模型，也不是显著性检验。若游戏版本真的改变了规则语义，应建立清楚区分的 ruleset；针对标注纠错的显式基线迁移尚未实现，不能绕过门禁偷偷重写旧集。

## 发布清单和接口

knowledge_publications 固定 policy/hash、知识/hash、数据集/hash、完整检索参数、回答模型/运行时配置、两份评测身份和报告、回答报告 hash、门禁诊断。manifestHash 由数据库对 manifest 与 gate 一起规范化计算。与原始规则、答案及复核的关联继续保留，失败的门禁记录也不可覆盖。

路径前缀 `/api/admin`：

| 方法与路径 | 作用 |
| --- | --- |
| POST /rulesets/{id}/publication-policies | 冻结策略，返回 201 |
| GET /publication-policies/{id} | 查看策略 |
| POST /publications | 提交 policyId、answerEvaluationId、retrievalRunId、idempotencyKey；返回 201 和 passed/gate |
| GET /publications/{id} | 查看完整清单和门禁诊断 |
| GET /rulesets/{id}/publication | 查看当前 publicationId、revision、eventId；初始 revision=0 |
| POST /rulesets/{id}/publication-transitions | 发布、回滚或停用，返回 201 和实际切换事件 |
| GET /rulesets/{id}/publication-history | 分页切换历史，按 revision 倒序 |

每个写接口使用独立 idempotencyKey；重试必须复用原 key 和同一规范化输入，改变输入返回 409。旧转换请求重试返回原事件，不再次激活那个版本，即使期间发生了停用或其他切换。需要当前状态时另读 head。

转换示例：

```json
{
  "idempotencyKey": "<操作 UUID>",
  "expectedRevision": 3,
  "action": "rollback",
  "publicationId": "<曾经成功激活的发布 UUID>",
  "note": "说明回滚原因"
}
```

## 并发、回滚与停用

首次及后续切换均锁定 ruleset 行；expectedRevision 不符返回 409。同一基线的两个管理员请求并发时只能有一个成功。新 publish 还必须匹配策略创建时的指针 revision/publicationId；基线已变化则需新策略与评测，不可把旧检查结果套到新基线上。

rollback 只接受本 ruleset 曾成功激活的 passed 发布；恢复整个知识/索引/模型配置清单，不重新解析、不重新生成向量。它依据原验收结果恢复已知版本，不按当前坏版本再做回归判分。应用运行配置不匹配时仍拒绝回滚：可能需要先恢复旧模型/应用部署，再切换知识指针。系统不代替部署平台切换程序或密钥。

deactivate 需要当前有激活版本，publicationId 必须为 null。模型适配器只在激活/运行校验时延迟创建；即使模型服务未配置、配置无效或已变更，也允许紧急停用；之后解析当前知识返回 KNOWLEDGE_NOT_PUBLISHED。这是面向后续公众入口的停止新回答机制，不能取消已经固定旧快照的在途执行。

数据库事件触发器更新 head，禁止绕过事件直接篡改指针、跳过 revision、覆盖/删除历史或激活未通过版本。应用层计算完整门禁，数据库额外检查来源报告、关键质量条件、作用域及切换关系；不宣称对持有数据库超级用户权限的人形成安全边界。审计写入失败时事件和指针同事务回滚。

内部 PublicationService.resolve 一次读取 head 并返回不可变 publication，校验当前运行配置。后续公众会话必须固定该清单和 publicationId，不能每次工具调用重新读取当前 head。本 PR 尚未开放公众问答，也未把管理员任意版本验收接口伪装成公众入口。

## 验证与实际状态

测试使用隔离 PostgreSQL/pgvector、真实 Pi、pg-boss 和本地合成模型；覆盖不同知识快照的发布/回滚、门禁失败、保留集/策略时序/参数约束、停用后的回归、并发切换、幂等重试、模型和 Embedding 配置失配、审计失败回滚、不可变数据库约束及鉴权。生产 HTTP 链路从固定策略和两份评测到人工复核、激活、停用及回滚完整运行。

测试中使用明确的合成部署号、语料及审核声明，不代表真实规则质量。真实 Azul 全文审核/标准集、真实供应商、公众会话/身份/额度、Swagger UI、Sentry、部署及恢复验收仍待完成。本功能不自动发布真实知识，不合并 GitHub PR。
