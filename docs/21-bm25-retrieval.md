# 版本化 BM25 关键词检索

更新日期：2026-11-06。依赖 draft-retrieval-diagnostics（PR #14）；新增第十四条 TypeORM 迁移 Bm25Retrieval1793836813000。本功能接入正式管理索引、关键词/混合检索、Pi 以及评测/发布链路；不改变默认排序或自动发布真实资料。

## 问题与方案

草稿基线中，反复出现的通用词会挤掉较相关的短规则，增加召回数量又会扩大关联图和预算缺口。原来的 ts_rank_cd 保留作为对照，新增显式可选 bm25-v1：用当前索引的词频、文档频率与规则长度校正关键词排序。它不能解决无词面重叠的口语别名、指代或歧义，也不能替代向量、重排、完整条件和人工评测。

## 固定算法与边界

复用 complete-rule-v1、NFKC/Intl 中文分词、ICU 身份、8000 字符完整规则上限和 128 个不同查询词上限。章节、适用条件和审核正文构成检索文本，编辑解释不入词表。词元以规范化 lexical_text 的空格分隔为准；不依赖 tsvector 的词频/位置截断，也未增加停用词、同义词或查询答案扩展。

bm25-v1 固定 k1=1.2、b=0.75，对去重后的每个命中查询词求和：

```text
IDF(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
score(d,q) = sum(IDF(t) * tf(t,d) * 2.2 /
                   (tf(t,d) + 1.2 * (0.25 + 0.75 * dl(d) / avgdl)))
```

N 是该索引的规则数，df 是含该词的规则数，dl 是词元数，avgdl 是总词元数/N。没有将其他游戏、版本、索引或候选题并入统计。自然对数、求和词序和分数降序/块 UUID 次序固定；重复查询词不重复加分。不先用旧排序截断候选再算 BM25，所有匹配规则参与评分后才 LIMIT。分数不等于答案置信度。

参数和 IDF 的参考见 [Lucene BM25Similarity](https://lucene.apache.org/core/9_12_3/core/org/apache/lucene/search/similarities/BM25Similarity.html)。本实现是固定公式的 PostgreSQL SQL 实现，没有声称与 Lucene 的分词、重叠位置、长度编码或浮点近似逐位相同；原排序参考 [PostgreSQL 18 文本检索](https://www.postgresql.org/docs/18/textsearch-controls.html)。

## 索引配置与旧版本

默认空请求继续生成原 schemaVersion=1，配置序列化/hash 和排序不改变。新配置 schemaVersion=2 额外固定 ranker=bm25-v1，其他切分/分词字段不变。同一知识快照的两种配置有不同 indexBuildId/configHash，可并存和分别评测。同配置并发构建仍复用一个索引和一条创建审计。

请求不能临时把旧索引改成 BM25；search 根据所绑定的不可变索引配置选择 SQL。ICU 不符仍失败关闭。新规则/分词/算法参数必须建立新索引，不能原地篡改统计。VectorService 使用同一个 KnowledgeIndexService 关键词分支，因此该 BM25 索引的向量构建和 RRF 会自动绑定相同基础索引；关键词分数不会直接与向量距离相加。

评测身份已有 indexConfigHash，回答/发布已有固定 indexBuildId 和部署版本约束。因此不同排序的报告、向量索引与发布配置不能混用；需要为 BM25 建立对应索引、评测和发布产物，不能沿用旧排序的通过记录。

## 构建与数据库保护

统计在 building→ready 的数据库 BEFORE UPDATE 触发器中从实际 retrieval_chunks 全量派生，和索引完成同事务提交：

- bm25_documents：每个片段的完整词元数量与词频 JSONB。
- bm25_corpora：同索引规则数和总词元数。
- bm25_terms：同索引每词的文档频率。

构建中已有的统计会被重建，调用者不能把伪造/不完整的统计带入 ready。片段归属检查阻止跨 build/release 统计；统计编辑和索引完成锁定同一 index_builds 行，ready 后增删改均拒绝。词表主键和片段范围索引、词频 JSONB GIN 用于检索，查询时复用持久统计，不重新计算全库 df/平均长度。

索引完成仍需既有全量规则覆盖门禁，失败会回滚统计和状态。原 schemaVersion=1 不创建 BM25 数据，迁移不改写已有索引。down 在存在任何 bm25-v1 索引时拒绝回退，避免删除不可变发布所依赖的统计；空隔离库支持完整回退/重建。生产迁移仍由独立运维步骤执行，Web 启动不自动迁移，不启用 synchronization。

目前单快照上限仍为 2000 规则/8 MiB manifest；本 SQL 是有范围索引的精确匹配评分，不是专用 BM25 扩展或分布式搜索引擎。真实大语料吞吐、并发和容量尚未验收，不能由小样本延迟外推。

## 管理 API 与诊断 CLI

```http
POST /api/admin/releases/{releaseId}/indexes
Authorization: Bearer <admin-token>
Content-Type: application/json

{"ranker":"bm25-v1"}
```

返回独立 indexBuildId/config/hash；GET /index-builds/{id} 可读配置。原 `{}` 或显式 `{"ranker":"ts-rank-cd-v1"}` 使用旧配置，未知排序/额外字段拒绝。OpenAPI 由实际严格契约生成。随后现有 search/context、vectors、评测和问答 API 继续使用返回的索引 ID，不新增用户侧参数。

草稿诊断配置增加 `"ranker":"bm25-v1"`；缺省仍为原排序。CLI 使用同一 BM25 评分 SQL 片段，但草稿统计在只读 CTE 内从私有规则生成，不写正式表。报告记录对应 SQL hash 和 lexicalCore=bm25-v1。只运行 development，holdout/答案要点不进入查询；原来的私有文件和权限策略不变。

## 真实开发草稿对照

使用 PR #14 相同私有 source/bundle、35 条规则、18 条关系，未修改题目、标注或规则。开发题 20，其中 18 可评分、2 无证据标注；每组运行失败 0。maxRules=20/maxChars=24000，Node 22.22.0/ICU 77.1/PostgreSQL 18.6。

| 当前用户问题 / limit | 原排序：搜索完整 | BM25：搜索完整 | 原排序：补全完整 | BM25：补全完整 | 原排序：完整且无缺口 | BM25：完整且无缺口 | BM25 有缺口题数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 5/18 | 7/18 | 8/18 | 11/18 | 8/18 | 11/18 | 0 |
| 3 | 9/18 | 11/18 | 14/18 | 14/18 | 14/18 | 14/18 | 0 |
| 6 | 12/18 | 15/18 | 15/18 | 17/18 | 14/18 | 17/18 | 0 |
| 12 | 16/18 | 15/18 | 17/18 | 16/18 | 13/18 | 7/18 | 11 |

人工标注 query、limit=6 时 BM25 搜索完整 15/18、补全完整及无缺口均 17/18；仍与当前问题口径分别记录。默认 6 下，原先两道回忆题恢复完整证据、未出现已完整题的退步，唯一未完整题属于歧义类。扩大到 12 却使大量关联补全占满预算，证明不能只看较大的召回数量或单项分数决定上线参数。

上述是未人工批准规则/候选标签上的开发结果，不能称为真实标准集通过或答案正确率。没有运行 holdout、调用模型供应商、批准资料、修改默认排序或发布。局部表现不能证明整体泛化；下一步仍需别名/歧义与关联策略实验，人工复核并冻结方案后再做独立验收。原始逐题报告仅保存在本地忽略目录 data/curation/azul-base-draft/diagnostics/bm25-*-report.json。

## 验证

合成真实 PostgreSQL 测试覆盖三规则独立数值例、常见词重复优势纠正、并发幂等、旧配置/hash 保留、数据库自动派生与伪造统计替换、ready 不可变、跨版本统计拒绝、无候选截断的草稿/正式排序逐项一致、空词/未命中/超限查询、管理员鉴权/严格参数、保留集隔离和迁移回退保护。生产 HTTP 先验证旧索引，再建立 BM25 索引贯穿向量/RRF、Pi、检索/答案评测、发布门禁、公众历史与微信测试传输；没有用模拟服务冒充真实供应商验收。
