# 草稿知识的开发集检索诊断

更新日期：2026-11-06。依赖 knowledge-curation；无新增数据库迁移、公众 API 或模型供应商调用。

## 用途和边界

后续已增加显式可选 [BM25 对照](21-bm25-retrieval.md)，缺省仍使用本文件的原排序。

真实规则还在 pending、候选标签尚未人工批准时，需要先发现分词、排序和关联补全的问题。本工具读取本地私有 source/bundle，生成明确标记为草稿的检索诊断。它不批准规则、不伪造 sealed release、不写正式索引或发布记录；结果不能传入发布门禁，也不代表答案质量通过。

生产问答仍只读取已批准并发布的知识。诊断不是 Pi 工具，不开放 HTTP 路由。人审、正式索引、独立保留集检索/回答验收和发布门禁保持独立。

## 与正式检索保持一致

packages/retrieval/src/core.ts 提供公共的完整规则构建、NFKC/Intl 中文分词、安全 tsquery 构造、SQL 评分投影及顺序、关联规则 BFS 和证据预算逻辑。正式索引继续通过有范围约束和 GIN 索引的 retrieval_chunks 查询。草稿用参数化 JSON CTE 在 PostgreSQL 内即时生成同样的 simple tsvector，并使用相同 to_tsquery、ts_rank_cd、分数降序和 chunk UUID 次序；不以 JavaScript 文本包含模拟数据库。

差异测试在真实 PostgreSQL 中，用相同正文、规则/块 ID 和参数逐项比较草稿 SQL 与正式 search 的排序/分数；并比较同 manifest 下正式 context 与公共函数的证据、页码/坐标、关系和预算缺口。原有跨版本/范围/不可变约束测试继续保留。

草稿使用来源指纹 + 稳定别名派生 UUID，修改候选标签/保留题不会影响同分排序。真实索引由数据库分配 ID，因此**同分项顺序可能不同**；正式发布索引需要重新评测。固定私有来源标题和草稿 ID 的证据序列化仍会与正式资料不同，接近字符预算阈值时也可能产生不同缺口。报告不能替代正式索引验收。

## 两种查询口径与保留集

- current_question：只使用最后一条用户消息；对应 Pi 强制首次检索的输入。提供的历史不会被自动改写进查询。
- annotated_query：显式使用开发集标注 query，可能已经包含历史指代或人工补充术语。用于诊断检索能力，不应声称是用户原始问题的线上效果。

只允许 split=development；holdout 的问题、标准 query、答案要点和证据标签不进入检索 SQL、逐题结果或汇总。完整 bundle 仍会解析校验并计算来源/整包 hash，不能因此宣称文件中完全未读取保留集。修改保留题不影响草稿规则/块 ID；测试验证其不改变开发题排序或指标。所有 requiredClaims/forbiddenClaims 均不进入检索输入，不能用标准答案增强 query。

## 只读与资源限制

诊断在 REPEATABLE READ + READ ONLY 事务执行，只运行 SET/SELECT/WITH。单条 SQL 超时 15 秒；题间检查取消和 60 秒协作式总期限，因此单条在途 SQL 不会被 AbortSignal 立即中止。bundle 最多 900000 UTF-8 字节、2000 条规则、100 道候选题，完整规则仍必须符合 8000 字符上限，不截断条件或例外。

CLI 的每个输入文件上限 16 MB。诊断默认 limit=6/maxRules=20/maxChars=24000，与问答默认预算一致；limit 可取 1–12。资料指纹不符、重复/不存在的来源 ordinal、没有开发题或无法完整切分时拒绝。题目校验/检索限制错误保留在分母；数据库故障/超时使整次运行失败，不能输出看似完整的报告。

## 指标口径

有证据标注的题目为 scorable；每个可接受证据组合内为 AND，组合间为 OR。失败题按零覆盖保留在分母。无证据标注的澄清/拒答题为 unscored，其覆盖率为 null，不充作正确题。

- searchCompleteRate：排序返回的规则是否已覆盖一个完整证据组合。
- contextCompleteRate：BFS 补全后是否覆盖一个完整证据组合。
- gapFreeContextCompleteRate：完整证据组合已覆盖、运行成功且 context 没有任何预算缺口的比例。
- meanSearchRecall/meanContextRecall：每题最佳证据组合的平均覆盖率。
- contextGapCases：存在预算缺口的题数，统计全体已运行开发题。

即使最后一项无缺口，也未验证规则正确、标签正确、语义蕴含、拒答行为或最终答案；它只诊断首次证据包，不能等同于最终可回答率。Pi 后续还可能搜索和读取证据。

## 本地运行与隐私

先准备私有 config.json，例如：

```json
{"queryMode":"current_question","limit":6,"maxRules":20,"maxChars":24000}
```

```sh
# 创建并清理隔离本地 PostgreSQL；复用测试 helper，不使用 DATABASE_URL。
npm run diagnose:draft -- /absolute/private/bundle.json /absolute/private/source.json /absolute/private/config.json /absolute/private/new-report.json --isolated
# 已配置管理员数据库时省略 --isolated；无自动迁移和持久写入。
node --env-file=.env --import tsx scripts/draft-diagnostics.ts /absolute/private/bundle.json /absolute/private/source.json /absolute/private/config.json /absolute/private/new-report.json
```

--isolated 在设置 TEST_DATABASE_ADMIN_URL 时仅允许显式 loopback 测试库，并创建/删除独立库；否则启动临时原生 PostgreSQL，使用后关闭和删除，不修改系统服务。诊断不需要 pg-boss、规则表或已发布版本。

输出路径必须尚不存在；使用独占创建和 0600 权限，目录应预先置 0700。报告包含私有用户问题、分词、规则别名、逐题结果，必须留在 Git 忽略的 data/ 或其他私有目录，不能提交 GitHub。stdout 仅输出配置、hash、计数与汇总；错误不输出原书、候选答案、文件路径或连接串。

报告固定 kind=draft-retrieval-diagnostic、publishable=false、labelsReviewed=false、answerQualityEvaluated=false，记录来源/整包/开发题 hash、SQL hash、算法及 Node/ICU/PostgreSQL 版本。实际未人工复核，所以不能改为 true。

## 真实 Azul 开发草稿基线

2026-11-06，本地 PostgreSQL 18.6、Node 22.22.0、ICU 77.1；使用前一功能生成的同一份私有草稿，35 条规则、18 条关系。只执行 20 道 development 候选题，其中 18 道有证据标注、2 道无证据标注；每组失败 0，后两题不计入覆盖率。没有运行 holdout，没有修改规则/标注或生产默认参数。

| 查询口径 / limit | 搜索完整证据 | 补全后完整证据 | 补全完整且无预算缺口 | 有缺口题数 |
| --- | --- | --- | --- | --- |
| 当前问题 / 1 | 5/18（27.8%） | 8/18（44.4%） | 8/18（44.4%） | 0 |
| 当前问题 / 3 | 9/18（50.0%） | 14/18（77.8%） | 14/18（77.8%） | 0 |
| 当前问题 / 6 | 12/18（66.7%） | 15/18（83.3%） | 14/18（77.8%） | 1 |
| 当前问题 / 12 | 16/18（88.9%） | 17/18（94.4%） | 13/18（72.2%） | 4 |
| 人工标准 query / 6 | 13/18（72.2%） | 15/18（83.3%） | 14/18（77.8%） | 1 |

固定 maxRules=20/maxChars=24000。扩大候选集提高了完整证据覆盖，却增加关联图补全的预算缺口；不能仅凭 94.4% 修改生产 limit。默认 6 下仍有三题未取全证据；标注查询主要改善该开发集唯一多轮题的初始搜索，对另三题的完整覆盖未改善。样本很小、规则/标签均未经人工审批，数字只是草稿相对诊断，不是标准集指标或上线结论。

原始报告位于本地忽略目录 data/curation/azul-base-draft/diagnostics/*-v2-report.json，未上传。下一步按失败归因评估术语归一化、排序/检索融合、条件关系策略和真实 Embedding；保留集在方案冻结与人工复核后再验收，不能用它反复调参。
