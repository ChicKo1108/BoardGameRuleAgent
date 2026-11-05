# 后端实现进度

当前目标：先完成后端，不开发产品前端；按功能及时提交 PR，不自动合并。

## PR：knowledge-storage

已实现：TypeORM 数据源、可回退迁移、游戏/规则集/来源文档/修订/来源块/规则/证据关联/规则关系；知识仓储和迁移 CLI。
数据库约束保护跨修订引用、修订身份及已审核内容；编辑与审核对同一修订加锁。
测试使用 embedded-postgres 启动隔离的真实 PostgreSQL，测试后关闭并删除测试目录。不使用生产连接，不修改系统服务。

运行：npm test；npm run typecheck:tests；DATABASE_URL=... npm run db:migrate。
迁移不随 Web 启动自动执行。db:revert 会撤销最后一条迁移并删除其表，生产操作须先备份并单独授权。

未实现：HTTP 管理接口、文档存储/解析适配器、队列、检索、问答、发布和评测、用户/额度、Swagger/Sentry。
下一功能 PR 建立经认证的知识管理 API 与结构化资料入库，后续对接用户提供的真实 PDF。
