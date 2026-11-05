# 项目文档

更新日期：2026-11-05。来源：本项目需求讨论与已确认技术决策。

| 文档 | 内容 |
| --- | --- |
| [产品范围与决策](00-product-and-decisions.md) | 用户目标、已确认需求、暂缓事项 |
| [系统架构](01-system-architecture.md) | 模块、组件职责、运行边界 |
| [知识数据模型](02-knowledge-data-model.md) | 实体、版本、来源、数据约束 |
| [入库与发布](03-ingestion-and-release.md) | 解析审核、切分、后台任务、发布回滚 |
| [RAG 设计](04-rag-and-answering.md) | 检索流程、Agent 工具、证据和答案 |
| [评测与实验](05-evaluation.md) | 数据集格式、实验矩阵、指标和门禁 |
| [API 与实施计划](06-api-and-roadmap.md) | API、后台页面、开发里程碑 |
| [向量与混合检索](11-hybrid-retrieval.md) | 模型适配、持久构建、pgvector、RRF、TokenHub 配置 |
| [知识版本与检索基线](10-knowledge-retrieval.md) | 冻结清单、中文检索、证据补全与边界 |
| [PDF 入库运行手册](09-pdf-ingestion.md) | 上传、队列、解析、审核与失败恢复 |
| [后端实现进度](08-backend-progress.md) | 实际完成范围与验证入口 |
| [候选问题来源](07-question-candidates.md) | 社区问题和对话测试草案 |

## 阅读约定

- 已确认：用户明确接受的需求和技术选择。
- 设计提案：准备实现但仍需工程验证的方案。
- 待验证：工具、模型、参数或未经规则书核对的答案。
- 已实现范围以项目根 README 和实际代码为准。

规则内容与标准答案必须读取用户提供的 PDF 后核验；已做本地解析链路验证，尚未形成经审核的完整知识库和标准答案。
