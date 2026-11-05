# 微信网站登录与账号历史归属

依赖 public-conversations，新增第十二条 TypeORM 迁移。实现微信网站应用 OAuth 换码、账号会话、游客历史归属与账号问题额度。没有新增产品前端。未配置 WECHAT_APP_ID/WECHAT_APP_SECRET 返回 503，不提供模拟账号成功入口。

协议依据是 [微信网站应用登录开发指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)，本次直接读取官方网页核对 qrconnect、snsapi_login、换码端点和返回身份字段；浏览工具无法解析时通过只读 HTTP 获取解压后的官方 HTML。登录状态/浏览器绑定和凭证轮换参考 [OWASP OAuth2 指南](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html) 与 [CSRF 登录防护](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。

## 部署与 API

先迁移数据库，配置准确 PUBLIC_APP_ORIGIN、已审核的网站应用 AppID/AppSecret，以及在微信开放平台注册的回调域。回调 URL 固定为 `<PUBLIC_APP_ORIGIN>/api/auth/wechat/callback`，不接受用户 redirect_uri 或 returnTo。HTTPS 生产环境沿用 __Host- Cookie。回调结束固定 303 到同 origin 的 `/`，清除查询中的 code/state；当前首页仍为已有工程状态页，登录产品界面后续实现。

PUBLIC_MEMBER_DAILY_QUESTIONS 默认 0，需显式配置，建议高于 PUBLIC_GUEST_DAILY_QUESTIONS；全站问题上限仍共同生效。账号数量上限 10000/天、游客上限 1000/天是配置取值边界，不是默认赠送额度。AppSecret 只放服务端密钥管理或私有环境变量，不发给前端、不写日志/数据库。

| 方法与路径 | 行为 |
| --- | --- |
| POST /api/auth/wechat/start | 有效游客 Cookie、精确 Origin 和 X-Boardgame-Request: 1，无请求体；返回授权 URL 和短期绑定 Cookie |
| GET /api/auth/wechat/callback | 微信回调 code/state；校验独立绑定 Cookie，成功后轮换会话并固定重定向 |
| GET /api/session | kind 为 guest/member，并返回该身份的额度和到期时间 |
| DELETE /api/session | 撤销当前设备会话；其他已登录设备保持有效 |

契约并入 /api/openapi。start 先验证游客凭证，空正文读取最多五秒；每个原会话十分钟最多五次，全站默认每分钟最多六十次。member 不能直接发起账户切换，需先退出，再以新游客会话登录，避免将账号 A 的历史自动归到账号 B。

## 浏览器绑定与一次性流程

原业务 Cookie 为 SameSite=Strict，跨站回调不能依赖它会被发送。因此 start 同时签发另一个随机的 HttpOnly/Secure/SameSite=Lax 绑定 Cookie（__Host-boardgame_oauth），绝对期限十分钟；state 与绑定秘密均为 32 字节随机值，数据库仅保存哈希并绑定原 browser_session、AppID 和完整回调 URL。

回调只接受一份 state 和至多一份 code。绑定 Cookie、state、原会话有效性、AppID、回调 URL 和期限全部匹配后，先事务化将流程从 pending 改为 exchanging，记录 code 哈希，再进行外部请求。并发/重复回调最多一个发出换码请求；code 哈希另有唯一约束。用户拒绝授权时缺少 code，流程变为 failed，不发请求。

换码请求只访问 `https://api.weixin.qq.com/sns/oauth2/access_token`，参数为 appid/secret/code/grant_type=authorization_code。端点不能通过部署环境或 HTTP 用户改为任意 URL；禁止重定向、不自动重试、请求八秒期限、响应最多 64 KiB，验证成功身份、access_token/expires_in 和 snsapi_login scope。供应商错误体/URL 不透传，凭证字段只在内存中短暂使用。

只按同 AppID 下的 openid 哈希绑定账号，不使用客户端 userId、未验证的 unionid，也不采集昵称/头像。不同 AppID 之间不会自动合并身份。当前不调用 userinfo 或保存 access_token/refresh_token，因为项目无需代理微信资源。

## 账号与不可变历史

换码成功后再次锁定原会话，检查它未退出/过期、流程仍有效；按 AppID+subjectHash 串行创建或读取一个 member principal。随后同事务：

1. 插入原 guest principal 到 member principal 的唯一不可变归属记录。
2. 撤销原游客的全部凭证，防止旧 Cookie 继续访问已归属历史。
3. 签发全新随机业务凭证，保存其哈希，绑定 member；不升级或复用游客凭证。
4. 将流程标为 succeeded 并写审计，最后下发新 Cookie、删除短期绑定 Cookie。

审计失败或原会话已改变会回滚身份创建、归属与凭证轮换。外部换码在事务之外执行；退出登录与换码并发时，退出可使回调失败，不能在未确认原会话的情况下归属历史。

原会话、问题、答案、额度所属 guest ID 保持不可变。principal_scope 在数据库中将账号自身与已归属游客组成可访问范围；会话列表、读取、提问、创建幂等和额度查询均使用此范围。登录后可以继续原游客对话，前提仍是其固定发布有效；换号后其他账号不能访问这些记录。

账号额度会汇总自身及所有归属游客当日已预留/消费的问题，不因登录或多设备重新登录清零。历史问题 key 的网络重试仍可返回原结果；新问题使用 member 额度。来自同一身份的两个设备并发登录只创建一个账号，各自游客历史均归属该账号，设备凭证分别存在。

## 中断与安全边界

流程一旦 exchanging 就不自动重新换码；供应商失败、超时、数据库提交失败或进程崩溃后，需要重新发起登录。旧 code/state 不能当作可重放的幂等凭证。完成事务但 Set-Cookie 响应丢失时，系统没有保存可重发的原始会话秘密；需清除旧失效 Cookie（退出接口）并重新登录，不能靠重复回调重新领取账号凭证。

未访问的 pending/exchanging 过期记录可能保留该存储状态，但过期回调不能使用。归属、身份和登录尝试有数据库不可变/转换保护，尚未实现账号删除、注销和保留清理。迁移 down 若存在 member 会明确拒绝，而不悄悄删除真实身份；需要备份/导出和专门迁移计划。正式回滚不可用删除账号来代替应用恢复。

按官方协议，AppSecret/code 在服务端换码请求 URL 中；网关/代理/观测必须避免记录完整 query，后续 Sentry 集成也需清理认证请求参数。应用当前不记录这些 URL、code、原始 state/绑定秘密或供应商 token。回调响应 no-store、Referrer-Policy:no-referrer、CSP default-src 'none'；回调地址本身不渲染第三方资源。state/Cookie 不能替代 HTTPS、可信域名和实际网站应用审核。

## 验证范围

隔离 PostgreSQL 与真实 Pi 公众问答验证：游客历史和额度归属、旧凭证失效、账号隔离、重复/并发回调、过期/错误绑定、退出并发、供应商失败/非法/超大响应、拒绝授权、审计失败回滚和多设备同一身份。登录测试不伪造公众 session 成功路径，而执行真实账号创建与轮换服务。

生产 Next.js HTTP 测试显式使用 tests/helpers/wechat-fetch.mjs 子进程预加载传输，将固定的微信换码请求路由到测试专用 loopback 服务；它只由测试命令注入，正常应用无法用环境变量替换供应商端点。链路覆盖 start、独立 Lax 绑定、callback、真实凭证轮换、游客历史归属、账号额度和登录后继续 Pi 问答。

该验证不等于真实微信扫码验收：尚无已开通的网站应用账号/密钥，未实际访问微信换码服务、验证审核回调域或手机扫码。真实微信、真实 Azul/模型质量、游戏目录、保留清理、资源限流、Sentry、Swagger UI 和上线验收继续待完成；不会因此把整个后端标为完成。
