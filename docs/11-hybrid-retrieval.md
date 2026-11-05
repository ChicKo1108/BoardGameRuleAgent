# 向量构建、混合检索与模型服务接入

## 实现范围

已实现可替换的 Embedding Provider、真实 pgvector 向量存储、持久构建任务、批次恢复、余弦距离精确查询、关键词/向量/RRF 对照检索和不可变检索运行记录。管理员可以通过 API 调试，尚未接入公众问答、Reranker、质量评测门禁或线上发布指针。

没有默认启用或付费调用任何供应商。当前自动化测试使用实际 PostgreSQL 18 + pgvector，以及本地合成 Embedding HTTP 服务。它验证工程行为与向量运算，不证明真实模型的语义检索质量。

## 数据与版本

关键词 `index_builds` 及片段保持冻结；`vector_indexes` 固定引用该索引和知识快照。相同片段可以建立多个不同模型配置的向量版本，便于公平对照，不必重复人工审核或复制片段。

完整检索身份为 rulesetId + releaseId + indexBuildId + vectorIndexId。向量模型、维度、部署修订、端点、输入前缀或长度配置变化时，创建新 vectorIndexId；查询配置必须与构建配置完全匹配。后续会话/发布必须固定这组身份，不能只保存模型名称。

Profile 不包含密钥，保存 providerId、端点 SHA-256、model、revision、dimensions、是否发送 dimensions、文档/查询前缀、输入长度上限、协议和距离类型。revision 是部署方的配置版本标签，不能保证供应商同名模型的底层权重不变；供应商提供固定快照时应使用并记录相应模型 ID。

向量使用 pgvector 的 `vector` 类型；同一表允许不同版本有不同维度，数据库触发器校验每个向量与所属版本的维度一致且非零。查询在版本过滤后计算余弦距离，不会把不同空间混在一起。当前采用精确查询，不建立 HNSW；ANN 的速度/召回权衡需另行测量。

## 构建与恢复

`queued → running → ready`；失败为 `retrying/failed`。任务与业务记录在同一 PostgreSQL 事务入队。

- 每批最多 8 个完整片段，成功后同时提交向量与批次记录；随后处理下一批。
- 默认有两次自动重试。进程崩溃或网络异常后，已经提交的批次不重复生成。
- 调用 HTTP 时不持有数据库事务；返回后重新锁定任务并核对尝试令牌。旧尝试不能覆盖新尝试或已完成版本。
- 单次 Provider 请求默认 30 秒，任务执行预算 150 秒，队列过期时间 180 秒。超出预算后可从批次检查点重试。
- 只有全部片段都有向量，数据库才允许 ready；半成品禁止检索。ready 版本及其向量不可覆盖。
- `retry` 仅接受失败状态。队列记录因保留策略被清除时，也可显式重建任务并继续已有批次。
- 网络超时或产物提交失败可能产生供应商已计费、但本地未记录的调用。批次 usage 不是最终账单，需与供应商账单核对；缺失 usage 为 null，不伪装成零成本。

没有任何自动截断或向量补零。超长文本、数量错误、维度不符、零向量、非有限数值、响应顺序重复等均失败。原文需拆分时应重新整理审核规则，保留条件和例外。

## Provider 接口

`EmbeddingProvider.embed(texts, document|query, signal)` 返回与输入一一对应的 vectors 和可空 usageTokens。HTTP 适配器采用 OpenAI 兼容请求，支持 float 输出，并按响应 index 恢复输入顺序。

只接受服务端配置的 HTTPS 端点（本机测试/本地模型允许 loopback HTTP）；不跟随重定向。请求、响应分别有文本/批次数量和 4 MiB 响应上限，超时和客户端取消可中止请求。对外错误只保留稳定代码，不返回供应商原始响应或密钥。

SDK 不是隔离供应商的必要条件；这里以小型协议适配器处理已验证的 HTTP 契约，业务流程不依赖特定 SDK。其他协议应增加适配器，不在任务逻辑中散布供应商判断。

## 环境配置与运行

先准备 PostgreSQL 18 和 pgvector（本地已验证 0.8.6，CI 使用固定镜像 0.8.7-pg18-trixie）。迁移执行 `CREATE EXTENSION IF NOT EXISTS vector`，部署账号需相应权限；回退应用迁移不会删除共享 vector 扩展。

在根 `.env` 与 `apps/web/.env.local` 分别配置 Worker 和 Next.js；密钥不提交。

```dotenv
EMBEDDING_ENDPOINT=https://provider.example/v1/embeddings
EMBEDDING_API_KEY=<local-secret>
EMBEDDING_PROVIDER_ID=<deployment-name>
EMBEDDING_MODEL=<actual-model-id>
EMBEDDING_REVISION=deployment-v1
EMBEDDING_DIMENSIONS=<expected-dimensions>
EMBEDDING_SEND_DIMENSIONS=false
EMBEDDING_MAX_INPUT_CHARS=2000
EMBEDDING_DOCUMENT_PREFIX=
EMBEDDING_QUERY_PREFIX=
WORKER_TASKS=vectors
```

```sh
npm run db:migrate
npm run queue:setup
npm run worker:start
```

`WORKER_TASKS` 默认 pdf；设置 vectors 可只运行向量任务，pdf,vectors 则运行两类任务。仅向量 Worker 不需要配置 PDF 解析路径。无模型配置时，向量构建/查询返回明确错误，不会用假向量兜底；已有状态和关键词对照仍可读取。

## TokenHub 接入候选（2026-11-05 核对）

用户正在比较模型服务，尚未选定或开通。TokenHub 可以作为候选，兼容文本向量接口。可从以下配置进行真实验收：

```dotenv
EMBEDDING_ENDPOINT=https://tokenhub.tencentmaas.com/v1/embeddings
EMBEDDING_PROVIDER_ID=tencent-tokenhub
EMBEDDING_MODEL=kinfra-text-embedding-4b
EMBEDDING_DIMENSIONS=2560
EMBEDDING_SEND_DIMENSIONS=false
EMBEDDING_MAX_INPUT_CHARS=2000
```

另设 API Key 和自定义部署修订标签。0.6B 对照模型为 kinfra-text-embedding-0.6b，固定 1024 维，需要创建独立向量版本。官方说明文本输入单条最多 2000 字符，维度固定，不能请求自定义维度。不要因页面同时展示模型 32k 上下文，就忽略接口层的 2000 字符限制。

来源：[TokenHub 向量模型](https://cloud.tencent.com/document/product/1823/133515)。问答模型需从[当前能力列表](https://cloud.tencent.com/document/product/1823/130051)选择支持工具调用和结构化输出的型号，随后验证 Pi 兼容性。尚未确认 TokenHub 的独立 Reranker 接口，不预设其与腾讯云其他重排产品共用配置。

百炼与硅基流动也可作为对照平台；最终根据同一批已审核桌游问题比较完整证据召回、正确率、延迟和成本，不因通用榜单或模型大小直接认定最佳供应商。

## 管理 API

所有路径加 `/api/admin` 前缀，需要 Bearer 管理员鉴权。

| 方法与路径 | 请求/用途 |
| --- | --- |
| `POST /index-builds/{id}/vectors` | `{}`，按当前服务端配置入队，返回 202 与 vectorIndexId |
| `GET /vector-indexes/{id}` | 配置、状态、尝试次数、已完成/总片段数和队列状态 |
| `POST /vector-indexes/{id}/retry` | `{}`，显式恢复失败任务 |
| `POST /vector-indexes/{id}/search` | query、mode、candidateLimit、limit、rrfK |
| `GET /retrieval-runs/{id}` | 请求关联 ID、完整配置、两路候选、结果、耗时、usage 与错误 |

搜索 mode 可选 lexical/vector/hybrid，默认 hybrid。每路默认 20 候选，最终默认 10，RRF k 默认 60，均为实验初值。融合分数为各路 `1/(k+rank)` 之和，不直接相加关键词分数与余弦相似度。返回保留两路排名、关键词分数、余弦距离和融合结果，可进行错误归因。

模型服务不可用时本次向量/混合查询失败并记录错误，不把关键词结果静默伪装成混合结果。可显式选择 lexical 模式进行对照。检索记录包含问题原文，仅管理员可读；生产上线前仍需落实个人数据保留/清理策略和公众权限。

来源引用与关联补全复用 `/index-builds/{id}/context`，必须使用搜索返回的同一 indexBuildId。模型不得决定版本、凭空构造来源或跳过补全缺口。

## 验证

测试不再使用不带 pgvector 的 embedded-postgres 二进制。macOS 可安装 `brew install postgresql@18 pgvector`，测试自动识别标准 Homebrew 路径；其他安装设 `PG_TEST_BIN`。每个测试文件启动单独的临时集群，随机密码、loopback 监听，结束关闭并删除。不会启动或使用 Homebrew 默认数据库服务。

CI 使用独立 pgvector 容器。`TEST_DATABASE_ADMIN_URL` 只接受 loopback 地址；每个 fixture 创建随机命名数据库并仅删除自己的数据库，从不读取业务 `DATABASE_URL` 作为测试目标。该管理员连接只应指向专用测试服务。

38 项测试包括真实余弦查询、RRF、版本/维度隔离、输出顺序验证、批次恢复、过期任务重建、旧任务覆盖保护、超时及 API 鉴权。生产 HTTP 测试贯穿 Next.js、实际 Worker、兼容协议的本地测试服务、真实 pgvector 和检索记录。测试不会访问真实供应商或产生模型费用。

待完成：真实模型/规则语料质量评测、术语词典、Reranker 对照、知识发布门禁、Pi 问答与公众能力。

参考：[OpenAI Embedding 协议](https://developers.openai.com/api/docs/guides/embeddings)、[pgvector 官方说明](https://github.com/pgvector/pgvector)。
