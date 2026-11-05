# API 与实施计划

以下表格区分已实现接口与后续规划；实际 schema 以鉴权后的 /api/admin/openapi 为准。完整混合检索、评测发布与问答仍待实现。

| 方法与路径 | 用途 | 状态 |
| --- | --- | --- |
| POST /api/admin/documents | 创建文档元数据 | 已实现 |
| PUT /api/admin/documents/{id}/file | 私有 PDF 上传 | 已实现 |
| POST /api/admin/revisions/{id}/parse | 异步解析 | 已实现 |
| GET /api/admin/jobs/{id} | 任务进度 | 已实现 |
| GET /api/admin/revisions/{id}/blocks | 来源块 | 已实现 |
| PATCH /api/admin/rules/{id} | 修改待审核规则 | 已实现 |
| POST /api/admin/revisions/{id}/approve | 审核资料 | 已实现 |
| POST /api/admin/rulesets/{id}/releases | 冻结知识快照 | 已实现，未代表发布 |
| POST /api/admin/releases/{id}/indexes | 完整规则关键词索引 | 已实现，向量后续接入 |
| POST /api/admin/index-builds/{id}/search | 限定版本关键词检索 | 已实现，管理员实验 |
| POST /api/admin/index-builds/{id}/context | 证据及关系补全 | 已实现 |
| POST /api/admin/evaluations | 创建评测 | 规划 |
| POST /api/admin/releases/{id}/publish | 通过门禁后发布 | 规划 |
| POST /api/conversations/{id}/messages | 正式问答 | 规划 |

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

用户已提供中文规则书，已完成私有隔离环境的解析链路验证，尚需全文审核与标准答案标注。模型、Embedding、Reranker 需实测选择；当前 Intl.Segmenter 是关键词检索基线，不是最终分词质量结论。
第一份完整评测报告必须使用真实来源；禁止编造页码或把社区回复直接当权威答案。
