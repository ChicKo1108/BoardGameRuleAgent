# RAG 与回答链路

当前已实现知识快照、关键词、pgvector 与 RRF 混合检索和关联补全，见 [向量运行说明](11-hybrid-retrieval.md)。Pi 受控问答及管理员验收已实现，见 [问答运行说明](13-pi-answering.md)。真实答案质量评测、重排与公众发布仍待完成。

## 检索流程

原始问题+必要上下文 → 指代消解/术语归一 → 游戏及版本过滤 → 关键词和向量双路召回 → 排名融合 → 可选重排 → 条件/例外补全 → 证据包。

- 保存原问题和改写问题，不自动补充玩家未提供的局面。
- 版本过滤在查询中执行，不能全库召回后交模型筛选。
- 入库与查询使用同版本中文分词和游戏词典；别名保留歧义。
- 使用排名融合，避免直接相加不同尺度的分数。
- 关键词关注术语和数字，向量关注口语表达，重排作为可开关实验项。
- 精确向量搜索作基线，HNSW 根据规模、延迟及召回实测引入。
- 初始实验可两路各 20 候选，最终约 6–10 片段；参数必须经过评测。
- 不把未经校准的相似度阈值当作“可回答”判定。
- 重排故障可降级融合排序，记录降级并监测质量。

## 工具与可信上下文

工具：search_rules({query, topic?})；read_rule_context({chunkIds})。
rulesetId、releaseId、indexBuildId 和权限由服务端注入，模型不得改写。
证据包包含 retrievalRunId、releaseId、interpretedQuery、证据 ID/内容/来源/角色与 gaps。
读取 chunkIds 时同样检查范围，不能凭 ID 读取其他候选版本。
核心 TypeScript 契约位于 packages/contracts。

## 受控回答流程

服务端必需首轮检索 → Pi 检查证据 → 有预算的补充检索 → 结构化答案 → 引用校验 → 保存最终结果。
限制工具调用次数、总时长、token 和费用。业务权限、额度、来源定位、版本固定由代码执行。

答案字段：status、ambiguity、assumedMeaning、answer、basis、citations、followUp。
- 有歧义先指出，再按最可能解释回答并确认；事实条件不足时不得猜局面。
- basis 区分 explicit/inferred/mixed；推导展示可核查的依据，不展示内部思维链。
- 缺失规则返回 insufficient_evidence；缺失局面信息返回 needs_context。
- 模型只引用 evidenceId，真实章节、页码和链接由服务端生成。

## 引用校验

1. ID 存在、属于本次证据和发布版本：代码保证。
2. 引用文字与来源一致：文本及位置检查。
3. 证据支持结论且条件完整：评测、辅助模型检查与人工审核。

失败最多执行一次针对性修正；仍失败不发送未经验证裁定。单次模型检查不能保证语义正确。
默认先发送检索/核对进度，完成校验再发正文，后续再评估正文 token streaming。

## 调试与缓存

检索实验页展示原问题、改写、双路候选及分数/排名、融合重排、关联补全、最终上下文。
缓存键包含规则范围、发布/索引版本和相关模型配置；不能复用其他版本证据。
首版不引入跨用户的回答缓存，避免上下文及隐私混淆。

## 官方参考

- https://www.postgresql.org/docs/current/textsearch-parsers.html
- https://github.com/pgvector/pgvector
- https://docling-project.github.io/docling/concepts/docling_document/
