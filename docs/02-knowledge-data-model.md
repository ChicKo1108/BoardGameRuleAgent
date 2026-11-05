# 知识数据模型

## 三种版本

1. ruleset：实际游戏规则范围，包括版本、语言、基础/扩展与玩法面。
2. document_revision：资料解析和审核修订，保留原始数据和编辑差异。
3. knowledge_release：上线使用的不可变知识快照，固定资料、规则和索引配置。

一次问答锁定 ruleset_id、release_id、index_build_id。发布不能改变正在运行的请求。
会话固定发布版本；旧会话升级时清理旧证据缓存，历史答案继续引用旧版本。

## 实体

| 表 | 核心内容 |
| --- | --- |
| games | 名称、别名、标识 |
| rulesets | 游戏、版本、语言、玩法及扩展范围 |
| source_documents | 来源名称、类型、发布方、文件地址、哈希 |
| document_revisions | 解析器及配置、原始结果、修订号、审核状态 |
| source_blocks | 段落/标题/图例/表格、原文、阅读顺序、页码、坐标 |
| rule_units | 经审核完整规则、类型、章节、条件、编辑解释 |
| rule_sources | 规则与来源块的多对多关联 |
| rule_relations | 条件、例外、示例、补充关系及审核状态 |
| knowledge_releases | 状态、内容清单哈希、发布时间 |
| release_members | 固定本次发布的规则单元版本 |
| index_builds | 分词/词典、切分、Embedding 配置及构建状态 |
| retrieval_chunks | 检索文本、父章节、规则单元、索引构建 |
| chunk_embeddings | 片段、模型版本、维度、向量 |
| ingestion_jobs | 阶段、输入输出、重试、错误与检查点 |
| retrieval_runs | 原始/改写问题、候选排名、最终证据、耗时 |
| answer_runs | 生成配置、证据快照、最终答案、引用、成本 |
| eval_cases / eval_runs | 标准要点、可接受证据组合、配置、报告 |

rule_units 是审核后的业务知识；retrieval_chunks 是检索材料。重建索引不应重复人工审核规则。
游戏专有术语、别名和分词词典独立版本化。

## 数据约束

- 原始解析、审核文字、编辑解释分开保存，解释不可冒充官方原文。
- 发布后的内容不可原地更新，修改产生新修订。
- PDF 页序号从 0 开始，印刷页码是独立可空文本字段。
- 一个规则或片段允许跨页、多来源块，不能强制绑定单页。
- 同一索引构建内片段唯一；同一片段+Embedding 配置禁止重复向量。
- 不同向量模型、维度不能直接混用；物理表/列及索引在选型后通过迁移落实。
- 关联关系必须检查适用规则范围，不能把其他扩展例外无条件合入基础版。
- 删除旧版本要考虑历史引用与保留期，不能随发布直接清理旧来源。

## RuleUnit 草案

```ts
interface RuleUnit {
  id: string;
  revisionId: string;
  sectionPath: string[];
  kind: 'rule' | 'exception' | 'definition' | 'example';
  reviewedText: string;
  applicability: string[];
  sourceRefs: { blockId: string; pdfPageIndex: number; printedPageLabel?: string }[];
  explanation?: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
}
```

当前是逻辑数据模型，尚未创建上述业务表。最终外键、唯一约束、并发控制与索引由实体实现阶段补全。
