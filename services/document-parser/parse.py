"""Native PDF text baseline; all output remains unapproved until human review."""
import json
import sys
import pdfplumber


def parse(path, config):
    result = {"pipelineVersion": "pdfplumber-regions-v2", "parserVersion": pdfplumber.__version__, "pages": [], "blocks": [], "warnings": []}
    configured = {p["pageIndex"]: p["regions"] for p in config.get("pageRegions", [])}
    labels = {p["pageIndex"]: p["label"] for p in config.get("pageLabels", [])}
    with pdfplumber.open(path) as pdf:
        if not 1 <= len(pdf.pages) <= 100:
            raise ValueError("PAGE_LIMIT_EXCEEDED")
        if any(i >= len(pdf.pages) for i in set(configured) | set(labels)):
            raise ValueError("INVALID_PAGE_CONFIG")
        total_text = 0
        for index, page in enumerate(pdf.pages):
            width, height = float(page.width), float(page.height)
            result["pages"].append({"pageIndex": index, "width": width, "height": height})
            regions = configured.get(index, [[0, 0, 1, 1]])
            boxes = [(r[0]*width, r[1]*height, r[2]*width, r[3]*height) for r in regions]
            result["warnings"].append({"code": "READING_ORDER_REVIEW", "pageIndex": index})
            page_text = 0
            for box in boxes:
                text = page.crop(box).extract_text(x_tolerance=2, y_tolerance=3) or ""
                if not text.strip():
                    continue
                page_text += len(text.strip())
                result["blocks"].append({"ordinal": len(result["blocks"]), "kind": "text", "rawText": text, "pdfPageIndex": index, "printedPageLabel": labels.get(index), "bbox": list(box)})
            total_text += page_text
            if page_text < 20:
                result["warnings"].append({"code": "LOW_TEXT_PAGE", "pageIndex": index})
            unassigned = [c for c in page.chars if str(c.get("text", "")).strip() and not any(b[0] <= (c["x0"]+c["x1"])/2 <= b[2] and b[1] <= (c["top"]+c["bottom"])/2 <= b[3] for b in boxes)]
            if unassigned:
                result["warnings"].append({"code": "UNASSIGNED_TEXT", "pageIndex": index})
            if page.images:
                result["warnings"].append({"code": "FIGURES_REQUIRE_REVIEW", "pageIndex": index})
            seen = set()
            for picture in page.images:
                box = (max(0,float(picture["x0"])), max(0,float(picture["top"])), min(width,float(picture["x1"])), min(height,float(picture["bottom"])))
                if box in seen or box[0] >= box[2] or box[1] >= box[3]:
                    continue
                seen.add(box)
                result["blocks"].append({"ordinal": len(result["blocks"]), "kind": "figure", "rawText": "", "pdfPageIndex": index, "printedPageLabel": labels.get(index), "bbox": list(box)})
            if len(result["blocks"]) > 2000:
                raise ValueError("BLOCK_LIMIT_EXCEEDED")
        if total_text < 20:
            raise ValueError("OCR_REQUIRED")
    return result


if __name__ == "__main__":
    try:
        result = parse(sys.argv[1], json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        code = str(error)
        allowed = {"PAGE_LIMIT_EXCEEDED", "INVALID_PAGE_CONFIG", "BLOCK_LIMIT_EXCEEDED", "OCR_REQUIRED"}
        print(json.dumps({"error": code if code in allowed else "INVALID_PDF"}))
        sys.exit(1)
