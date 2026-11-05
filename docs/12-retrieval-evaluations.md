# 检索评测运行手册

本阶段实现检索评测后端，不代表已验证《花砖物语》的答案质量。依赖 hybrid-retrieval PR，新增第六条 TypeORM 迁移；没有公众评测 API。所有接口使用管理员鉴权，可从 `/api/admin/openapi` 获取完整请求/响应 schema。

## 固定数据与实验身份

评测集绑定一个 sealed 知识快照。管理员导入每题的稳定业务 ID、分类、严重程度、development/holdout 划分、对话、明确的检索 query、预期行为、必要/禁止结论、可接受证据组合及 reviewNote。证据引用该快照内具体 rule UUID，数据库阻止跨快照证据。同一规则在另一修订的 UUID 不自动等价，需要重新映射并复审；跨版本比较使用 case ID 对齐。case ID 是标注者维护的稳定标识，服务不会自动猜测映射。

每个证据组合内部是 AND，多个组合之间是 OR。`[[主规则,例外],[另一条完整规则]]` 表示覆盖任一整个组合才算完整。answer/answer_with_assumption 必须有证据；clarify/abstain 可以没有，但这些题不会自动计为答对。

reviewNote 是管理员对审核过程的记录，系统不能证明是否实际人工核验。现有社区候选题仍未成为标准答案。示例和自动测试只使用明确标为合成的规则；用户的 PDF、其全文以及未经审核答案不上传公开仓库。

评测集最多 100 题，应用限制规范化 JSON 不超过 900000 字节，HTTP 请求仍受 1 MiB 限制。集合以 name+revision 在快照内唯一；完全相同导入返回原 ID，修改内容必须使用新 revision。数据集和逐题结果不可更新/删除，manifest hash 由 PostgreSQL 计算。

每次运行固定 dataset ID/hash、release ID/hash、关键词索引配置 hash、可选向量索引 ID/profile/hash、检索模式、候选数量、Top K、RRF K、上下文预算、评分器/检索器/补全器版本和 Node 版本。运行显式选择 development 或 holdout，不存在默认混合集。

## 运行步骤

1. 依照入库手册人工审核资料，建立知识快照和关键词索引。向量/混合实验还需要一个 ready 的向量索引。
2. `POST /api/admin/releases/{releaseId}/evaluation-datasets` 导入固定评测集；`GET /api/admin/evaluation-datasets/{id}` 导出完整数据/hash。
3. 执行数据库迁移、`npm run queue:setup`，使用 `WORKER_TASKS=evaluations npm run worker:start` 启动评测 Worker。可与 pdf、vectors 组合；关键词实验不需要模型服务。Web 和 Worker 使用同版本代码与 Node，模型实验还须匹配向量构建的 Embedding 配置。
4. `POST /api/admin/evaluation-datasets/{id}/runs` 返回 202 与 runId。例如请求：

```json
{
  "idempotencyKey": "<每个新实验使用新的 UUID，网络重试复用原值>",
  "config": {
    "indexBuildId": "<关键词索引 UUID>",
    "vectorIndexId": null,
    "mode": "lexical",
    "split": "development",
    "limit": 10,
    "candidateLimit": 20,
    "rrfK": 60,
    "context": { "maxRules": 20, "maxChars": 32000 }
  }
}
```

vector/hybrid 模式必须指定 vectorIndexId；lexical 模式必须为 null。context 为 null 时仅评搜索，启用时同一次运行报告搜索与补全后两组指标。Top K 最大 20，以满足补全工具的输入上限。纯关键词不消耗 Embedding，也不使用 candidateLimit 或 rrfK；比较时保持这些无效参数不变，避免误读为有效实验差异。

5. `GET /api/admin/evaluation-runs/{runId}` 读取状态、固定身份和汇总；`GET /api/admin/evaluation-runs/{runId}/results?limit=25&offset=0` 分页读取逐题原始搜索、模型用量、上下文、页码/坐标引用、缺口和评分。
6. 同一数据集、split 与配置运行新的实验需新 idempotencyKey；同一 key 的重复请求不会重复入队，变更数据集或参数会报 409。对照实验一次只改一个因素；稳定性实验重复同一配置并保留各 runId。

## 指标口径

- 完整证据率：至少覆盖一个完整可接受证据组合的题数 / 有标准证据的题数。
- 最佳组合召回：对每个组合计算命中比例，再取最大值；不把不同互斥组合拼成一个“正确”组合。
- MRR：首次命中任一标准证据的倒数排名。另报完整组合的倒数完成排名：在所有已完整覆盖组合中，取最早被全部收集到的排名倒数。前者高不能掩盖遗漏例外。
- 在规则层去重后计算排名。补全列表是确定性遍历顺序，补全后的倒数排名只描述证据列表位置，不是新一轮相关性排序。
- 分类与严重程度分别报告数量、分母、未评分题和指标；零分母返回 null，不能报告 100%。
- 模型调用失败的有标准证据题仍在分母里，按零分计，并列出 errorCode。失败题不从报表中消失。终态 completed 表示任务执行完毕，**不表示质量达标**；completed_with_errors 表示存在执行失败。
- P50/P95 是逐题检索加补全的墙钟耗时（含失败），采用 nearest-rank；不包含排队时间，不是聊天延迟或首字延迟。
- 用量报告已知 tokens 与未知用量题数；未持久化前发生中断的请求、失败响应不提供的用量不在已知 tokens 中，因此不能当完整账单或费用。

有 query 的 multi_turn 案例只是测给定检索输入，不测对话改写。requiredClaims、forbiddenClaims、expectedBehavior 和 messages 被保存，但本阶段不做生成答案、歧义处理、拒答或语义支持判分；报告明确 `answerQualityEvaluated:false`。检索命中率不是答案正确率，也不会直接授权知识发布。

## 恢复与边界

运行及 pg-boss 入队在同一事务完成。每题检索在事务外执行，随后以尝试 token 校验并提交不可变结果。进程中断重试只处理未提交题目，旧尝试无法覆盖新结果；重复的外部模型请求仍可能计费，不能宣称 exactly-once 计费。

当前每个任务串行运行最多 100 题，单题信号预算 35 秒、整次尝试 55 分钟，队列到期 60 分钟，自动重试两次。数据库自身 statement_timeout 为 15 秒；信号不能立刻取消正在执行的 SQL，因此 35 秒是协作式上限。Worker 停止后可依赖队列超时重投和检查点恢复。查询错误保存为逐题失败，不自动掩盖后重测；要复测它们应创建新运行。

基础设施故障导致任务失败时可 `POST /api/admin/evaluation-runs/{id}/retry`，body `{}`。已丢失/清理的队列记录可以重建；已提交题目保留。若版本变化，使用原版本 Worker 恢复，或新建实验，不能拼接不同评分器/Node 版本的结果。报告和原始结果同终态提交；未覆盖全部所选题目时数据库拒绝完成。

holdout 的防调参依赖开发流程：当前单管理员可查看所有题目，没有隐藏标签或独立审核账号。最终发布门禁、人工争议题审核、答案/引用语义评分、解析质量评测以及真实供应商对比尚未实现。本阶段不会自动发布。

## 验证

`tests/evaluations.test.ts` 覆盖多种完整证据组合、部分命中、零分母、失败分母、跨版本限制、不可变标注、幂等请求、显式保留集、关联补全增益与预算缺口、混合检索及用量、中断恢复、队列记录缺失恢复、旧任务竞争、管理员鉴权和 OpenAPI。迁移回滚/重建沿用存储测试。

`npm run build && npm run test:http` 使用真实 Next.js HTTP、独立 PostgreSQL/pgvector、pg-boss live Worker 和本地模拟模型服务，从合成规则入库到混合评测报告验证完整调用链。不读取真实模型密钥，不代表任何供应商或真实规则质量验收。
