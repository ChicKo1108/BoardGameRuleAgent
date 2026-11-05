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
