# 公众问答、历史与恢复

依赖 guest-sessions，新增第十一条 TypeORM 迁移。游客现在可以通过后端创建会话、问答及读取历史；请求只能由其 Cookie 所属主体访问，不接受客户端指定用户、模型、历史、工具或知识索引。微信登录与账号历史归属已实现，见 [微信登录](18-wechat-login.md)；产品前端仍未开发。

## 发布与会话范围

创建会话时从 PublicationService.resolve 取得已激活且运行配置匹配的完整发布清单；数据库再次检查当前指针。会话固定 publicationId/rulesetId，消息固定实际检索输入与服务端执行 UUID。每次新消息要求该发布仍是当前版本；版本切换返回 CONVERSATION_VERSION_CHANGED，停用返回 KNOWLEDGE_NOT_PUBLISHED，已有历史仍可查。继续使用新版本需建立新会话；不把不同规则版本的历史自动混合。

预留与开始执行之间会再次锁定并检查发布指针。派发完成后视为在途执行，后续停用不会取消已授权调用。真正创建 answer_run 时再次比较完整 expectedConfig，避免配置在预检后改变；实际完成的 public_turn 由数据库验证其来源运行、完整输入、模型配置、发布和答案完全一致。

## API

全部使用 /api/session 下发的 Cookie，公众 OpenAPI 见 /api/openapi。GET 响应 no-store，写请求要求精确 Origin、X-Boardgame-Request: 1 和 application/json。JSON 流上限 8 KiB、读取期限 5 秒；请求 ID 由服务端生成。未知额外字段拒绝。

| 方法与路径 | 输入与结果 |
| --- | --- |
| POST /api/conversations | idempotencyKey、rulesetId；返回 id、publicationId、revision |
| GET /api/conversations | 分页自己的会话；limit/offset |
| GET /api/conversations/{id} | 自己的会话和当前 revision |
| POST /api/conversations/{id}/messages | idempotencyKey、expectedRevision、question；返回消息状态和校验后的答案 |
| GET /api/conversations/{id}/messages | 分页消息、答案与稳定错误码 |

示例：

```json
{
  "idempotencyKey": "<新问题 UUID；网络重试必须复用>",
  "expectedRevision": 0,
  "question": "从工厂拿花砖时，能只拿其中一部分吗？"
}
```

成功 HTTP 200 表示请求已处理，仍需查看消息 state；重复请求可能返回 running。GET 历史可以轮询状态。答案仅包含已校验的正文、歧义/假设/确认、依据类型和服务端来源引用，不返回模型配置、原始推理流、管理员审计或其他身份信息。所有权不符统一 404，先鉴权再读取正文和查询来源。

## 历史与并发

服务端取最近五个 completed 回答的完整问题/答案片段，按时间顺序作为最多十条历史消息；failed 不进入模型上下文，全部历史仍在分页记录中。历史保留状态、歧义、假设、正文、依据类型和 followUp，不复用旧引用作为当前证据。超出窗口的早期局面不保证模型记得，需要用户重新提供；当前没有自动摘要或指代改写质量验收。

为容纳完整长答案及澄清信息，单条 Agent history 上限由 4000 调整到 12000 字符，保留十条上限。公众写请求不接受 history。Pi 运行时升级为 pi-rules-agent-v2，旧运行配置不能直接作为新版本发布依据，需要重新评测。模型输入字节/调用/输出/费用预算仍然生效，历史过大可能导致安全失败而非未经预算的调用。

expectedRevision 是会话所有已接收问题的数量，包括失败题。数据库锁与唯一约束保证同一会话最多一个 prepared/running；未完成时新问题返回 CONVERSATION_BUSY，过时 revision 返回 409。同 UUID、相同问题和同一 expectedRevision 复用原消息，改变输入拒绝；其他会话不能占用该消息 UUID。每游客暂限 100 个会话、每会话 200 题，超出后返回限额错误；清理/归档策略待后续实现。

## 额度、调用与恢复

接收问题与创建额度预留在同一数据库事务中提交，失败会整体回滚；不在占有事务连接时再请求另一连接做配置预检。派发时再用同一事务将额度改为 dispatched、消息改为 running，之后才能进入 Pi 的检索/Embedding/生成调用。每题一个服务端 executionKey，来源 answer_run 可追溯；公众执行审计 actor=public。

状态：prepared → running → completed/failed；prepared 也可在取消或过期后 failed。预留失败不会产生消息或增加 revision。派发后，无论模型拒答、供应商失败、预算失败或请求取消，保留一次问题额度，终态结算后仍不可退款。

- 请求网络重试只返回原消息，不重做 running/failed 的执行。
- 已保存 answer_run，但尚未交付公众结果：GET/重试从该运行恢复并结算，不再次调用模型。
- prepared 超过两分钟：读取时释放尚未派发额度，标记 ANSWER_INTERRUPTED。
- running 的协作时限为已评测 Agent 时限加 30 秒。中断或未保存运行时，读取到期记录后结算并标记失败；原执行键不会被重新启动。
- 模型/基础设施失败：只返回 ANSWER_UNAVAILABLE，无供应商错误体；历史仍可访问。

同步模型调用会受请求 AbortSignal 约束。进程可能在外部服务已消费但本地提交前崩溃，不能承诺供应商计费 exactly-once；本系统通过不自动重做不明执行避免重复付费。过期状态目前由读取/新提问时协调回收，尚无独立周期清理 Worker；未访问记录可保留进行中存储状态。

## 验证与剩余工作

真实 PostgreSQL/pgvector、pg-boss 与 Pi 配合合成 SSE 模型，验证公开回答与发布绑定、服务端历史、分页、主体隔离、重复/并发、额度、供应商失败、停用历史、处理中断和已保存答案恢复。另验证 15 个并行会话创建不会占满十连接池。生产 Next.js HTTP 从游客凭证、发布门禁、混合检索、来源引用到历史和额度贯穿。

这些是工程验证，未证明真实 Azul 答案达标。真实知识审核与标准集、真实模型/微信验收、公开游戏目录、删除/保留清理、网关资源限流、Sentry、Swagger UI 和部署/负载恢复验收仍待完成。公众额度默认关闭，部署前必须明确配置且只能激活已验收知识。
