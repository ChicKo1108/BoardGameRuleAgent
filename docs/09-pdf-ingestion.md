# PDF 入库运行手册

## 实现边界

此功能承接知识管理 API，完成私有 PDF 上传、持久任务、解析产物和人工审核门禁。它不是已发布的 RAG 知识库；尚未实现语义切分、向量索引、检索评测与问答。

pg-boss 将任务放在 PostgreSQL 的 `boardgame_queue` schema；独立 Node.js Worker 领取任务并运行 Python 解析器。上传请求立即返回任务编号，耗时解析不会占用 HTTP 请求。Web 重启不会丢失已提交任务；Worker 崩溃后的任务由队列超时和有限重试恢复。队列与业务状态的写入共享数据库事务，避免只写了其中一边。

原始文件和解析 JSON 以 SHA-256 为文件名保存在私有目录；原子创建防止并发上传覆盖已有文件。数据库保存元数据和来源位置，不把 PDF 塞进字段。当前适配器是私有文件系统：Web/Worker 必须挂载同一持久卷；跨主机部署需要共享卷或后续对象存储适配器。不能使用临时无状态函数磁盘。

## 安装与运行

先 `nvm use`、`npm ci`。安装 Python 3.12 与隔离虚拟环境：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r services/document-parser/requirements.txt
```

根 `.env`（Worker/迁移）与 `apps/web/.env.local`（Next.js）配置相同的数据库和私有存储路径：

```dotenv
DATABASE_URL=postgresql://user:password@localhost:5432/boardgame
ADMIN_API_TOKEN=<至少32字符的随机值>
STORAGE_ROOT=/absolute/private/boardgame-data
PARSER_PYTHON=/absolute/project/.venv/bin/python
PARSER_SCRIPT=/absolute/project/services/document-parser/parse.py
```

`STORAGE_ROOT` 不得放入 Web 的 public 目录。生产部署在隔离容器内运行解析器，并设置内存、CPU 与磁盘配额；当前应用有文件大小、页数、产物大小与运行时限，尚未提供容器级资源配置。

```sh
npm run db:migrate
npm run queue:setup
npm run worker:start
```

Web 另行执行 `npm run build && npm start`。`queue:setup` 是显式部署步骤，Web 和正常 Worker 不自动迁移队列 schema。升级队列依赖需先在隔离数据库验证迁移与回滚方案，队列 schema 不由 TypeORM 回退命令管理。

## 管理接口顺序

所有路径以 `/api/admin` 开头，需要管理员 Bearer token。JSON 响应为 `{ data, requestId }`，错误为 `{ error: { code }, requestId }`。

1. 创建游戏、规则集；计算 PDF SHA-256 后 `POST /documents` 登记元数据。
2. `PUT /documents/{id}/file`，`Content-Type: application/pdf`，请求体为原始二进制；最多 20 MiB，必须匹配登记哈希。重复上传幂等。`GET` 同路径下载，仅限管理员。
3. `POST /documents/{id}/revisions` 保存解析配置。
4. `POST /revisions/{id}/parse`，JSON `{}`，返回 HTTP 202 和 `jobId`；同一修订重复请求返回相同任务。
5. `GET /jobs/{id}` 查看业务状态、队列状态、尝试次数和脱敏错误码。
6. 成功后 `GET /revisions/{id}/parse-result` 查不可变原始产物；来源块已原子写入，修订进入 `awaiting_review`。
7. 对照原 PDF 创建/修改规则单元及其来源、条件和例外关联。图例的空文本不是已识别说明，必须人工解释并关联对应图示来源。
8. `POST /revisions/{id}/parser-review`，`{ "note": "具体记录如何核对阅读顺序、遗漏文字和图例" }`。审核记录不可覆盖。未确认解析警告时数据库阻止批准修订；规则审核约束仍同时生效。
9. `POST /revisions/{id}/approve` 冻结修订。这只是资料审核，不是发布检索版本。

完整接口与 schema：`GET /api/admin/openapi`，可导入 Swagger。当前没有实现 Swagger UI。

## 解析器选择与质量限制

首个可运行适配器使用固定版本 pdfplumber 0.11.8，作为原生文本 PDF 的可复现基线。Docling 仍是后续需要用同一语料评测的候选，不宣称当前基线优于 Docling 或已经解决版面识别。

实际中文规则书存在双栏和图示。默认整页提取会混合不同栏的文字，因此支持按页声明有序的矩形区域。坐标配置是归一化的 `[left, top, right, bottom]`；输出 bbox 则是 PDF 点坐标，原点左上。PDF 页索引从 0 开始，印刷页码未核对时保持 null。

```json
{
  "parserConfig": {
    "engine": "pdfplumber",
    "pageRegions": [
      { "pageIndex": 3, "regions": [[0,0,0.5,1],[0.5,0,1,1]] }
    ]
  }
}
```

区域顺序决定块顺序。配置拒绝重叠和重复页；区域外的文字触发警告。每页输出阅读顺序待核对警告；图片保留位置且要求图例审核；文字过少的页触发警告。只有图像、无可用文字的整份文档返回 `OCR_REQUIRED`。不做自动 OCR、图意理解、表格结构还原或规则语义抽取。原始块可供人工审核，不直接充当检索 chunk。

## 失败恢复与存储

- 默认自动重试两次，间隔退避。包括格式错误也在有界重试内结束，之后转人工处理，避免无限循环。
- `POST /jobs/{id}/retry` 仅接受队列已失败的任务，沿用任务 ID 并记录审计。需修复文件或配置时，创建新文档或新修订；不要改写旧产物。
- 单次解析最多 120 秒，队列任务过期时间 180 秒。输出最多 16 MiB、100 页、2000 块；工作进程每次处理一个任务。
- 任务尝试令牌保护最终写入；已经开始的新尝试会使旧尝试无法覆盖其产物。重复成功任务不重复写来源块。
- Worker 的异常堆栈、PDF 内容和本地路径不返回客户端，错误使用稳定代码；完整 Sentry 集成仍待后续功能。
- 原始产物先落存储，再事务提交引用。数据库失败可能留下未引用的哈希文件，不会发布半份产物。尚未实现垃圾回收；备份与恢复需同时覆盖数据库和私有存储。
- 成功/失败队列记录按保留策略清理，业务任务与解析产物长期保留；超过保留期的失败任务应创建新修订重新处理。

## 可复现验证

`npm test` 使用临时真实 PostgreSQL、合成 PDF 和实际 Python 解析器，覆盖并发幂等、事务回滚、失败重试、审核门禁、旧任务覆盖保护、超时和鉴权。需先安装解析器依赖；CI 会安装。

`npm run build && npm run test:http` 启动隔离的生产 Next.js、真实数据库和活跃 Worker，检查实际 HTTP 上传/下载、创建任务、解析产物及待审核状态。所有临时数据库和文件在结束时删除。

可选验证本地私有文件（不会提交或长期导入）：

```sh
INGESTION_TEST_PDF=/absolute/private/rules.pdf \
INGESTION_TEST_CONFIG=/absolute/private/parser-config.json \
npm run test:http
```

配置文件直接包含 `engine` 与 `pageRegions`，不套 `parserConfig` 外层。输出只含哈希、块数和警告；不要把原文、截图或规则书提交到公共仓库。

2026-11-05 本地真实中文 PDF 验证：6 页，7 个文本区域、185 个底层图片对象、13 条审核警告；最终 awaiting_review。仅对已目视检查的 PDF 第 4 页配置左右分栏，其余页仍需要版面审核。这证明链路可运行，不代表全文抽取质量合格。
