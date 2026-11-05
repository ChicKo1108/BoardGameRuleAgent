# 桌游规则助手

面向桌游玩家的规则回忆和争议解答应用。核心研发是可审核知识库、RAG 检索、证据引用与质量评测。

## 当前状态

已初始化 npm workspaces、Next.js 应用、存活检查 API、共享契约、TypeORM 数据源工厂、Pi 依赖和 Worker 入口。
已实现知识存储表、可回退迁移和仓储约束，详见 [后端进度](docs/08-backend-progress.md)。
已实现带鉴权的知识管理 API、结构化来源导入、审核和 OpenAPI 文档。
已实现私有 PDF 上传、pg-boss 持久队列、Python 解析 Worker 与人工审核门禁，见 [入库运行手册](docs/09-pdf-ingestion.md)。
已实现审核知识快照、中文关键词检索基线、同版本证据与关联补全，见 [知识版本与检索](docs/10-knowledge-retrieval.md)。
已实现可恢复向量构建、pgvector 与 RRF 混合检索，见 [向量接入文档](docs/11-hybrid-retrieval.md)。
尚未完成真实模型质量评测、发布门禁、聊天、公众登录、Swagger UI 和 Sentry 集成。
当前首页是工程状态页，不是产品设计稿。真实规则书仅用于本地隔离验证，原文和模型密钥均不进入仓库。

## 启动

```sh
nvm use
npm ci
# 解析测试还需安装 services/document-parser/requirements.txt
npm run dev
```

打开 http://localhost:3000。`GET /api/health` 只检查 Web 进程存活，不检查数据库或模型。

```sh
# 数据库测试需要 PostgreSQL 18 + pgvector，配置见 docs/11-hybrid-retrieval.md
npm run typecheck
npm run typecheck:tests
npm test
npm run worker:check
npm run build
npm run test:http
npm start
```

使用 Node.js 22.22.0（Pi 当前依赖要求 >=22.19.0），不要使用系统默认 Node.js 20。
当前首页和构建无需数据库；接入数据库时参考 `.env.example`。
Next.js 环境变量放 `apps/web/.env.local`；Worker/迁移命令后续显式加载根 `.env`。

## 工程目录

- `apps/web`：Next.js 用户界面、管理界面和业务 API。
- `apps/worker`：异步入库、索引和评测任务。
- `packages/contracts`：应用自有的接口契约。
- `packages/domain`：业务模型与规则。
- `packages/db`：TypeORM、迁移和检索 Repository。
- `packages/agent`：Pi 集成、工具、提示词和答案校验。
- `packages/retrieval`：检索算法与适配器。
- `packages/evaluations`：测试集、评测和实验。
- `services/document-parser`：Python PDF 解析适配器与依赖。
- `docs`：产品范围、架构、知识库、检索与开发计划。

从 [文档索引](docs/README.md) 开始阅读。设计文档中的目标不代表已实现功能。
