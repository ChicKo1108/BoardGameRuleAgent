# 游客会话与问题额度

依赖 knowledge-publication，新增第十条 TypeORM 迁移。实现浏览器游客身份、会话鉴权、撤销与问题额度基础。此阶段没有开放公众模型调用；额度预留/派发/结算是服务端编排接口，后续会话问答必须接入这些接口，不能绕过。

## 凭证与浏览器接口

服务端生成 32 字节 CSPRNG 凭证，浏览器只持有不含身份内容的 Cookie；数据库保存 SHA-256 哈希，不保存原始凭证。HTTPS 使用 `__Host-boardgame_session`、Secure、HttpOnly、SameSite=Strict、Path=/，不设置 Domain。仅 loopback HTTP 开发使用另一个 Cookie 名字。设计参考 [OWASP 会话管理指南](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet)。

配置 PUBLIC_APP_ORIGIN 为准确 HTTPS origin，无路径或结尾斜线；HTTP 仅允许 localhost/127.0.0.1/[::1]。未配置时接口返回 503。ttl 默认 30 天、绝对到期，不滑动续期。Cookie 不能从 URL、JSON 或客户端 principalId 注入身份；重复同名 Cookie 拒绝。

- POST /api/session：没有请求体。创建游客凭证；已有有效凭证返回当前会话，不换号、不延期。凭证无效返回 401，不静默创建新身份。
- GET /api/session：查看游客类型、到期时间、当日个人额度和剩余额度。没有返回凭证、内部 principalId 或其他用户数据。
- DELETE /api/session：撤销当前凭证并清 Cookie，可重复调用。已过期/不存在凭证也可清 Cookie。
- GET /api/openapi：公众接口 OpenAPI 3.1。管理员 API 继续使用鉴权后的 /api/admin/openapi。

写请求要求 Origin 精确匹配并带 `X-Boardgame-Request: 1`；拒绝跨站 Fetch Metadata 和跨源 Origin，不开放 CORS。命令行客户端测试也需显式带这些头。响应 no-store，Vary: Cookie, Origin，只返回稳定错误码，不记录凭证。Cookie/CSRF 防护不等于机器人防护，也不替代后续微信扫码登录。

凭证有效性及撤销时间由数据库时钟判断。会话身份/到期时间不可修改，撤销不可恢复。已开始并得到服务端授权的在途请求不因后续退出立即取消；后续请求会被拒绝。登录/访客历史迁移、凭证轮换及数据保留清理任务尚待账号模块实现。

## 额度与状态机

PUBLIC_GUEST_DAILY_QUESTIONS 和 PUBLIC_GLOBAL_DAILY_QUESTIONS 默认均为 0；必须配置正数才允许预留。前者是每游客每日问题数，后者是整个服务共享每日问题数。每日边界使用 PostgreSQL 的 Asia/Shanghai，返回准确 resetAt，不依赖实例系统时区。

服务端 reserve(token,{id,requestHash}) 在验证并锁定凭证后，通过 PostgreSQL 事务锁跨实例串行检查个人及全站预算。id 是服务端请求的幂等 UUID，requestHash 是规范化请求的 SHA-256；后续问答应包含实际问题、会话、发布身份等。相同请求只占一次额度，内容变化返回 409，其他身份尝试同 key 返回 404。客户端没有预留、退款或设置额度的 HTTP 接口。

状态：reserved → dispatched → settled；reserved 也可转 released。

- reserved：两分钟执行窗口，暂时占额度。过期预留不计有效占用，同日及有效期内才能派发；跨过中国时区午夜也不能派发旧额度。
- dispatched：在任何模型/Embedding 外部调用之前确认。此后不能退款，即使调用超时或供应商用量未知；防止失败/重试绕过限额。
- settled：编排完成后的终态，持续计入原当日问题额度。
- released：仅确认尚未开始外部调用时使用；释放后同 key 重试仍返回 released，不能重新生成一次额度。新执行需要新请求。

expired reserved 不会自动重置身份或改写原输入，派发返回 ALLOWANCE_EXPIRED。状态转换的身份与合法路径另由数据库触发器保护，旧记录不能删改。预留失败和数据库事务回滚不会消费问题额度。dispatched 后崩溃会保留占用，这是避免不明消费被当作免费请求的保守行为；恢复时应结合后续问答记录，不能重新支付执行。

剩余额度取个人与全站剩余的较小值。全站锁是当前单库架构的正确性基线，持锁期间没有网络调用；负载验证后再决定是否分片。所有副本必须使用一致的额度配置，不能用更高配置的实例绕过部署策略。它限制的是问题数量，不是精确美元账单，必须结合已实现的单次 Agent 预算和后续公众调用编排使用。

## 匿名滥用与运营边界

浏览器删 Cookie、退出后新建游客，都会得到新游客身份；个人额度无法抵抗这一行为，全站预算负责限制总体模型问题数。不能宣称已实现设备唯一身份或抗刷。当前初始化凭证有跨副本共享的全站每分钟上限 PUBLIC_SESSION_MINTS_PER_MINUTE（默认 60），不信任任意 X-Forwarded-For，也没有擅自以不可信 IP 作为身份。

公网上线前仍需网关限流/可信代理接入、登录、账号额度和会话历史，以及凭证/过期额度保留清理。新建身份响应丢失会留下不可恢复的孤立身份；不把凭证放进响应日志来方便恢复。当前未实现注册、微信登录或公众聊天，不创建模拟登录成功入口。

## 验证

真实隔离 PostgreSQL 测试覆盖哈希凭证、到期/撤销、并发多实例额度、幂等及跨身份 key、全站预算、退款边界、过期派发、数据库保护、跨站/恶意身份输入和配置关闭。生产 Next.js HTTP 覆盖 Cookie 创建/读取、跨站拒绝、额度展示、退出及公众 OpenAPI。测试仅使用生成凭证和合成请求，无真实账号、密钥或用户数据。
