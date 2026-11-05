# API 与实施计划

以下是总体规划；部分知识管理接口已实现，实际路径和状态以 docs/08-backend-progress.md 及鉴权后的 /api/admin/openapi 为准。解析、发布、检索与问答接口仍待实现。

| 方法与路径 | 用途 |
| --- | --- |
| POST /api/admin/documents | 创建上传记录 |
| POST /api/admin/documents/{id}/parse | 异步解析 |
| GET /api/admin/jobs/{id} | 任务进度 |
| GET /api/admin/revisions/{id}/blocks | 查看来源块 |
| PATCH /api/admin/rule-units/{id} | 修改未发布内容 |
| POST /api/admin/revisions/{id}/approve | 审核通过 |
| POST /api/admin/releases | 创建候选知识版本 |
| POST /api/admin/releases/{id}/build | 构建索引 |
| POST /api/admin/retrieval/debug | 检索调试 |
| POST /api/admin/evaluations | 创建评测 |
| POST /api/admin/releases/{id}/publish | 发布 |
| POST /api/conversations/{id}/messages | 正式问答 |

统一考虑鉴权、输入校验、幂等、分页、错误码和 request_id。Swagger/OpenAPI 必须反映实际实现，不公开伪造成功响应。

## 首批后台页面

1. 文档审核：原页、解析块、修订差异、规则关系。
2. 检索实验：候选、排名、重排、补全和证据包。
3. 评测比较：配置、指标、失败归因和回归。

## 开发阶段

- M0 工程底座：目录、依赖、共享契约、运行命令、文档。
- M1 知识入库：TypeORM 业务迁移、上传、解析、定位、人工审核。
- M2 检索：规则切分、关键词/向量/混合、调试界面。
- M3 评测：人工核验种子集、对照实验、报告与失败归因。
- M4 Agent：证据回答、多轮、歧义、拒答、引用校验。
- M5 发布治理：评测门禁、知识发布、回滚、审计和恢复。
- M6 公开能力：登录、游客额度、历史、限流及安全检查。
- M7 上线验证：CI/CD、环境隔离、压力测试、备份恢复、成本和异常监控。

Swagger 和 Sentry 随实际接口与任务实现同步接入。不能用成功 HTTP 响应替代 RAG 正确性评测。
核心开发优先，暂不推进支付、资质申请等外围事务。

## 当前缺失输入

用户持有的花砖物语中文规则书尚未提供。模型、Embedding、Reranker、分词器需实测选择。
第一份完整评测报告必须使用真实来源；禁止编造页码或把社区回复直接当权威答案。
