# PDF 文档解析

当前提供可重复的 pdfplumber 原生文字解析基线，不宣称自动理解图示。
安装：`python -m pip install -r services/document-parser/requirements.txt`。Worker 的 PARSER_PYTHON 指向该 Python，PARSER_SCRIPT 为 parse.py 绝对路径。

输入：命令参数为私有临时 PDF 路径，stdin 为已校验 JSON 配置；输出为 JSON，禁止日志混入 stdout。
配置支持 pageRegions（0 起始页码，归一化矩形，以列表顺序读取）。不重叠区域可以纠正双栏交错，未覆盖文字产生审核警告。
输出保留页面尺寸、0 起始页码、左上原点 PDF 点坐标、文字区域和图片位置。印刷页码不猜测。
每页阅读顺序和图例必须人工核验；纯扫描文件拒绝为 OCR_REQUIRED，不能伪造空解析成功。
限制：20 MiB 上传、100 页、2000 块、120 秒、16 MiB 子进程输出。生产容器还应设置内存/CPU 上限。

Docling 仍为后续质量对比候选。此实现是可审核的文字层基线，不能以它替代图例理解验证或扫描件 OCR。
原始规则书不入库到 Git；合成 PDF 由 tests/helpers/pdf.ts 在测试运行时生成。
