# 可复现知识整理与真实规则草稿

更新日期：2026-11-06。依赖 wechat-login，新增第十三条 TypeORM 迁移。本功能将人工/辅助整理的规则、条件/例外关系和候选题封装为可重复导入的私有 bundle，解决逐条请求难以复现、UUID 无法跨环境映射和来源改变后仍沿用旧标注的问题。**导入只生成 pending 规则，不能批准资料或发布知识。**

## 来源指纹

GET /api/admin/revisions/{id}/curation-template 返回规范化 source 和 sourceFingerprint。指纹包含文档 SHA-256、完整 parserConfig、pipeline/parser 版本，以及按 ordinal 排序的全部来源块：原始文字、类型、PDF 页索引、印刷页码、坐标。规则和图例均参与绑定，不使用临时数据库 UUID。结构化人工导入明确记录 structured-import-v1，不伪装成已运行 PDF 解析器。

curation-source-v1 使用稳定键序列化后 SHA-256；属性顺序不影响指纹，来源内容/位置/配置变化会失配。导入事务锁定修订并重新读取真实来源，不信任用户提供的指纹作为事实。原始 PDF 字节仍由上传哈希验证。

解析器升级到 pdfplumber-regions-v2，支持显式 pageLabels：

```json
{
  "engine": "pdfplumber",
  "pageLabels": [{ "pageIndex": 1, "label": "2" }],
  "pageRegions": [{ "pageIndex": 2, "regions": [[0,0,0.5,1],[0.5,0,1,1]] }]
}
```

PDF 页索引从 0 开始，label 是管理员核对后的印刷页码，不是 OCR 自动识别结果。拒绝重复页标签、空标签和不存在的页；未提供时保持 null。v1 历史结果仍可读取，已有来源不改写。更换解析配置/管线需新修订和新 bundle，不把旧定位套在新结果上。

## 私有整理包

输入有 schemaVersion=1、name、revision、sourceFingerprint、rules、relations、cases。每条 rule 使用稳定 alias、kind、reviewedText、sectionPath、applicability、explanation 和 sourceOrdinals；没有 reviewStatus 字段，不能指定 approved。sourceOrdinals 指当前精确来源中的块，允许同一条规则绑定文字和图例。规范正文与编辑解释独立；解释不能充当规则引用。

relations 使用 from/to alias 与 condition/exception/example/supplement。cases 复用现有评测字段，但用 acceptableEvidenceAliases 替代数据库 UUID；完整组合内为 AND、组合之间为 OR。无证据标注只允许 clarify/abstain。拒绝重名别名、非法/重复关系、未知证据、重复题号和危险对象属性别名。

最多 2000 规则、4000 关系、100 道题，规范化 bundle 最多 900000 UTF-8 字节；规则正文最多 8000 字符。最终索引仍检查加入章节/适用条件后的完整长度，过长应按语义修订，不能以截断规避。超出上限或任一来源不合法，整个事务失败，不留部分规则。

## 导入、修改与审核

| 方法与路径（前缀 /api/admin） | 行为 |
| --- | --- |
| GET /revisions/{id}/curation-template | 导出私有来源和指纹 |
| POST /revisions/{id}/curation-imports | idempotencyKey + bundle；原子创建待审核规则/关系/不可变映射，201 |
| GET /curation-imports/{id} | 读取原 bundle、hash 和实际 alias→UUID |
| POST /curation-imports/{id}/evaluation-datasets | 人工复核题目后映射到指定已封存知识快照，201 |
| GET /curation-imports/{id}/annotation-reviews | 分页查看标签复核声明、数据集和请求 ID |

修订必须 awaiting_review 且尚无规则，避免整包覆盖已有编辑。首次导入后，原 bundle/map/hash 不可变；规则内容继续使用现有 PATCH /rules/{id} 审核和修改。相同 key、修订和规范化内容返回原映射，包括之后已审核的修订；改变内容返回 409。不同 key 不能向已有规则的修订再次整包导入，重整需新修订。源内容和审核写入沿用修订行锁，审计失败整体回滚。

导入后按现有规则审核接口逐条检查正文、所有来源、条件/例外关系；显式确认解析警告，再批准修订。文件中有警告时，仅导入 bundle 不会创建 parser-review。批准/建立快照仍是独立操作，不能把完成导入当作质量通过。

## 标签复核与快照映射

只有 sealed release 明确包含该整理包修订时，才能把题目别名映射为该快照的真实规则 UUID。materialize 请求需要 releaseId、数据集 name/revision、annotationReviewNote（至少十字符）；复核声明独立保存且不可覆盖，相同数据集改动声明返回冲突。

管理员应对照**实际编辑并批准后的规则**重新检查问题、要点、拒答边界和完整证据组合，不能只看最初草稿。模型/辅助生成的标注本身不等于人工标准答案，代码也不能证明操作者实际阅读。资料或标准有变化时创建新修订/新数据集，保留旧映射和复核记录。开发/保留划分和发布门禁继续由既有模块执行。

## 本地 CLI 与隐私

```sh
npm run curation -- fingerprint /absolute/private/source.json
npm run curation -- validate /absolute/private/bundle.json /absolute/private/source.json
# 配置目标数据库后运行；此命令不迁移、不批准、不发布。
node --env-file=.env --import tsx scripts/curation.ts import <revision-uuid> /absolute/private/bundle.json <idempotency-uuid>
```

CLI 输出只包含 hash、数量和状态，错误不输出规则原文、数据库连接或私有文件内容。scripts 独立 ESM 配置并纳入根 typecheck/CI。API 与 CLI 使用同一契约及服务；CLI 是具有数据库权限的管理员工具，不替代 HTTP 身份鉴权。

原书、解析 JSON、bundle、候选答案要点和逐条复核稿保存在 Git 忽略的 data/ 私有目录；新文件权限 0600、目录 0700。不要放入 public/、提交 GitHub 或通过日志发送。仓库测试只用合成语料，CI 不依赖用户的原始规则书。

## 本次真实资料验证

2026-11-06 对用户提供的六页中文 PDF 逐页渲染查看；使用有序区域区分正文双栏、基础结束规则、灰墙变体及署名。保留整个文档来源，但整理规则只覆盖彩色墙面基础玩法，不纳入灰墙变体知识。

本地生成 35 条规则草稿、18 条关系、40 道候选题（development 20 / holdout 20）。印刷页码按实际页脚设置；地板扣分图等使用图像来源绑定，并标记待人工复核。对原文件没有明确交代的边界，候选标签保留拒答/澄清，不用常识填成权威答案。

真实上传→pg-boss→Python→数据库→来源指纹→bundle 导入在隔离数据库运行通过：6 页、198 个来源块、13 个警告；35 条规则全部 pending，approved=0、修订 awaiting_review、知识发布=0。临时数据库和私有 PDF 副本测试后删除；本地私有草稿、复核稿与计数报告保留。198 是版面/底层图片块数，不是语义图例数。

这些数量证明整理/导入可复现，不能证明检索召回或答案正确率。本次没有生成正式真实评测报告、调用模型供应商、批准真实规则或发布公众知识。下一步仍需人工核对规则与候选标注，并做解析器/切分/术语/向量的真实对照评测。

## 自动验证

测试覆盖来源/坐标/版本指纹、并发幂等、pending 状态、变更拒绝、证据映射、标签声明不可变、审计失败回滚、页标签与越界配置、危险别名及管理员鉴权。生产 Next.js HTTP 从生成 PDF 的解析、导入、独立规则批准、快照到标签映射贯穿，再继续既有检索/问答/发布/登录验证。合成规则可自动批准用于工程测试；真实资料不会自动通过。
