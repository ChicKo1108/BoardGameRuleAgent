# 后端实现进度

当前目标：先完成后端，不开发产品前端；按功能及时提交 PR，不自动合并。

## PR：knowledge-storage

已实现：TypeORM 数据源、可回退迁移、游戏/规则集/来源文档/修订/来源块/规则/证据关联/规则关系；知识仓储和迁移 CLI。
数据库约束保护跨修订引用、修订身份及已审核内容；编辑与审核对同一修订加锁。
测试使用 embedded-postgres 启动隔离的真实 PostgreSQL，测试后关闭并删除测试目录。不使用生产连接，不修改系统服务。

运行：npm test；npm run typecheck:tests；DATABASE_URL=... npm run db:migrate。
迁移不随 Web 启动自动执行。db:revert 会撤销最后一条迁移并删除其表，生产操作须先备份并单独授权。

在 knowledge-storage PR 边界上尚未实现 HTTP 管理接口；后续完成情况见下节。文档存储/解析适配器、队列、检索、问答、发布和评测、用户/额度与 Sentry 仍待实现。
下一功能 PR 建立经认证的知识管理 API 与结构化资料入库，后续对接用户提供的真实 PDF。

## PR：knowledge-admin-api（依赖 knowledge-storage）

实现 Next.js 管理 API：游戏/规则集/文档元数据、修订、结构化来源块、规则编辑、来源查阅、规则关联与审核冻结。
单管理员服务端 Bearer token 鉴权，未配置时关闭访问；它不替代后续公众微信登录。所有写操作与审计记录同事务提交。
Zod 严格请求校验、1 MiB 请求体限制、参数化查询、分页和统一脱敏错误；请求 ID 关联日志。
OpenAPI 3.1 从实际路由和 schema 生成，GET /api/admin/openapi（需管理员 token），可导入 Swagger。尚未添加 Swagger UI。
文档登记仅保存元数据，不表示 PDF 已上传；来源块导入是解析适配接口，不是假装完成自动解析。
运行 Next.js 前在 apps/web/.env.local 配置 DATABASE_URL 和 ADMIN_API_TOKEN，并从根 .env 执行迁移。原始 PDF 和密钥不提交。

验证：13 项真实 PostgreSQL/接口测试、类型检查、生产构建通过。npm run test:http 在构建后启动临时 Next.js 与数据库，验证真实 HTTP 鉴权、创建/查询和 OpenAPI；已加入 CI。

## PR：pdf-ingestion（依赖 knowledge-admin-api）

实现私有文件存储、PDF 哈希验证、事务化任务入队、pg-boss Worker、原生 PDF 文本解析、页码/坐标溯源、审核警告、失败状态和显式重试。解析原始产物不可覆盖，已开始新尝试后旧尝试无法覆盖结果。新增 TypeORM 迁移和 OpenAPI 接口。

解析器当前是 pdfplumber 可复现基线；中文多栏与图例需要人工核对，Docling 对比仍待开展。文件存储当前要求 Web/Worker 使用相同持久卷，尚未实现 S3 适配器。详见 [运行手册](09-pdf-ingestion.md)。

验证：21 项测试、类型检查、Worker 模块检查、生产构建和生产 HTTP 链路通过。2026-11-05 使用用户提供的中文 PDF 在临时数据库验证，6 页、192 个来源块（7 个文本区域、185 个底层图片对象），13 条审核警告，最终状态 awaiting_review；未自动批准或发布。图片对象数不等于语义图例数。原文未进入仓库，测试结束清理私有副本。

## PR：knowledge-retrieval（依赖 pdf-ingestion）

实现同规则集已审核资料的完整不可变知识快照、原文与规则 manifest/hash、规则成员和关系；冻结后的内容、索引和规则集身份由数据库保护。基于完整规则与同版本中文分词建立关键词检索基线，查询限定版本，证据恢复原始页码/坐标并补全关联；数量或字符预算不足明确返回缺口。新增管理员 API/OpenAPI，尚未提供公众检索或问答。

验证：30 项测试、类型检查、Worker 检查、生产构建及真实 HTTP 贯穿链路。合成语料验证工程行为；真实中文规则的审核和检索质量评测仍未完成。详细运行与限制见 [知识版本与检索基线](10-knowledge-retrieval.md)。

## PR：hybrid-retrieval（依赖 knowledge-retrieval）

实现 Embedding 协议适配器、持久批量构建与检查点恢复、真实 pgvector 余弦查询、RRF 融合、配置/向量空间隔离、不可变运行记录及管理员 API/OpenAPI。向量服务未配置时不伪造结果。测试环境切换为原生 PostgreSQL 18 或 CI pgvector 容器，独立数据库隔离。

验证：38 项测试、类型检查、Worker 检查、生产构建、真实 HTTP 贯穿链路。模型输出来自本地合成服务，尚未做真实供应商或真实桌游质量验收。运行与 TokenHub 候选配置见 [向量与混合检索](11-hybrid-retrieval.md)。

## PR：retrieval-evaluations（依赖 hybrid-retrieval）

实现不可变评测数据集与快照证据映射、显式开发/保留集、关键词/向量/混合检索异步评测、逐题结果与汇总报告。完整证据组合判分，搜索与上下文补全分开统计，失败保留在分母；不对未标注证据的题目或生成答案宣称通过。模型/索引/评分器身份固定，幂等入队、检查点恢复与旧尝试隔离，管理员 API 和 OpenAPI 已接通。

验证：47 项测试、类型检查、Worker 模块检查、生产构建、真实 Next.js HTTP/pgvector/pg-boss Worker 贯穿评测链路。用本地合成模型验证工程，尚未形成真实 Azul 标准集、供应商对比或答案质量验收；没有自动发布。运行与指标口径见 [检索评测手册](12-retrieval-evaluations.md)。
