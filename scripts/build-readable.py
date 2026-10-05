#!/usr/bin/env python3
"""把 PDF / PPTX / DOCX 转成低成本阅读格式。

文字页写入 Markdown。页面里嵌着的图单独存成文件，并在对应段落写上索引。
整页几乎没有文字时，先尝试 OCR；OCR 能读出成段文字就只留 Markdown，
否则把该页存成图片，交给之后的多模态模型看。

不执行文档里的代码，也不做数值计算。已存在且不比源文件旧的结果会跳过。
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import fitz

ROOT = Path("/root/sjtu-mcm-website")
KNOW = ROOT / "data" / "knowledge"
OUT = KNOW / "readable"
TEXT_PAGE = 80
MAX_IMAGE_BYTES = 900_000

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def safe_name(name: str) -> str:
    cleaned = re.sub(r"[^\w.\-一-鿿]+", "_", name).strip("._")
    return cleaned[:60] or "file"


def doc_id(rel: str) -> str:
    digest = hashlib.sha1(rel.encode()).hexdigest()[:10]
    return f"{digest}_{safe_name(Path(rel).stem)}"


def load_sources() -> list[dict]:
    rows: dict[str, dict] = {}

    def add(path: Path, title: str, parent: str, token: str = ""):
        if not path.exists():
            return
        rel = str(path.relative_to(ROOT))
        suf = path.suffix.lower()
        if suf not in {".pdf", ".pptx", ".docx"}:
            return
        rows[rel] = {
            "path": rel,
            "title": title or path.name,
            "parent": parent,
            "token": token,
            "suffix": suf,
        }

    embedded = json.loads((KNOW / "embedded-manifest.json").read_text())
    for item in embedded.get("items", []):
        if not item.get("ok") or item.get("kind") != "file":
            continue
        add(ROOT / item["path"], item.get("name") or "", item.get("doc_title") or "", item.get("token") or "")

    manifest = json.loads((KNOW / "manifest.json").read_text())
    for item in manifest.get("files", []):
        if not item.get("ok"):
            continue
        add(ROOT / item["path"], item.get("name") or "", "课程表附件", item.get("token") or "")
    return list(rows.values())


_TOKEN_INDEX: dict[str, str] | None = None


def token_index() -> dict[str, str]:
    global _TOKEN_INDEX
    if _TOKEN_INDEX is not None:
        return _TOKEN_INDEX
    found: dict[str, str] = {}
    for md in (KNOW / "docs").glob("*.md"):
        text = md.read_text(encoding="utf-8", errors="replace")
        for match in re.finditer(r'token="([^"]+)"', text):
            token = match.group(1)
            if token in found:
                continue
            window = text[max(0, match.start() - 280) : match.end() + 180]
            window = re.sub(r"<[^>]+>", " ", window)
            window = re.sub(r"\s+", " ", window).strip()
            found[token] = window[:240]
    _TOKEN_INDEX = found
    return found


def clean_neighbor(window: str) -> str:
    """去掉云文档切片里残留的标签和属性，只留能读的题名。"""
    window = re.sub(r"<[^>]*>", " ", window)
    window = re.sub(r"<[^>\n]*$", " ", window)
    window = re.sub(r"\b[\w:.-]+\s*=\s*\"[^\"]*\"?", " ", window)
    window = re.sub(r"/>", " ", window)
    window = re.sub(r"[<>]", " ", window)
    window = re.sub(r"\b[A-Za-z0-9]{18,}\b", " ", window)

    def drop_token(match: re.Match) -> str:
        word = match.group(0)
        kinds = sum([any(c.islower() for c in word), any(c.isupper() for c in word), any(c.isdigit() for c in word)])
        if len(word) >= 10 and kinds >= 3:
            return " "
        return word

    window = re.sub(r"\b[A-Za-z0-9]{10,}\b", drop_token, window)
    window = re.sub(r"(?:^|\s)(?:source|token|mime|name|size)\b.*$", " ", window)
    window = re.sub(r"\s+", " ", window).strip(" ·>|:-/\"'`=")
    if len(window) < 8 or "mime=" in window or "application/" in window:
        return ""
    if not re.search(r"\d{4}|[\u4e00-\u9fff]", window) and len(re.findall(r"[A-Za-z]{3,}", window)) < 2:
        return ""
    return window[:180]


def parent_context(token: str, parent_title: str) -> str:
    window = clean_neighbor(token_index().get(token, "") if token else "")
    if not window:
        return parent_title
    return f"{parent_title}。邻近原文：{window}"


def as_rgb(pix: fitz.Pixmap) -> fitz.Pixmap:
    if pix.alpha:
        pix = fitz.Pixmap(pix, 0)
    if pix.n != 3:
        pix = fitz.Pixmap(fitz.csRGB, pix)
        if pix.alpha:
            pix = fitz.Pixmap(pix, 0)
    return pix


def save_jpeg(pix: fitz.Pixmap, dest: Path) -> None:
    pix = as_rgb(pix)
    if pix.width > 2200:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    data = pix.tobytes("jpeg", jpg_quality=68)
    if len(data) > MAX_IMAGE_BYTES:
        return
    dest.write_bytes(data)


def ocr_png(png: bytes) -> str:
    exe = shutil.which("tesseract")
    if not exe:
        return ""
    lang = "chi_sim+eng"
    try:
        proc = subprocess.run(
            [exe, "stdin", "stdout", "-l", lang, "--psm", "6"],
            input=png,
            capture_output=True,
            timeout=40,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return ""
    if proc.returncode != 0:
        proc = subprocess.run(
            [exe, "stdin", "stdout", "-l", "eng", "--psm", "6"],
            input=png,
            capture_output=True,
            timeout=40,
            check=False,
        )
    return proc.stdout.decode("utf-8", errors="replace").strip()


def render_page(page: fitz.Page, dest: Path) -> bool:
    scale = 110 / 72
    pix = as_rgb(page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False))
    if pix.width > 1400:
        scale *= 1400 / pix.width
        pix = as_rgb(page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False))
    data = pix.tobytes("jpeg", jpg_quality=65)
    if len(data) > MAX_IMAGE_BYTES:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return True


def inset_images(doc: fitz.Document, page: fitz.Page, image_dir: Path, page_no: int) -> list[str]:
    saved: list[str] = []
    page_area = max(page.rect.width * page.rect.height, 1)
    seen: set[int] = set()
    for info in page.get_image_info(xrefs=True):
        xref = int(info.get("xref") or 0)
        if xref <= 0 or xref in seen:
            continue
        seen.add(xref)
        bbox = fitz.Rect(info["bbox"])
        if bbox.width < 48 or bbox.height < 48:
            continue
        if bbox.width * bbox.height > page_area * 0.82:
            continue
        try:
            pix = fitz.Pixmap(doc, xref)
        except Exception:
            continue
        if pix.width < 48 or pix.height < 48:
            continue
        name = f"p{page_no}-{len(saved) + 1}.jpg"
        dest = image_dir / name
        try:
            save_jpeg(pix, dest)
        except Exception:
            continue
        if dest.exists() and dest.stat().st_size > 0:
            saved.append(f"images/{name}")
        if len(saved) >= 6:
            break
    return saved


def convert_pdf(src: Path, out: Path) -> dict:
    image_dir = out / "images"
    doc = fitz.open(src)
    parts: list[str] = []
    image_count = 0
    text_pages = 0
    for index, page in enumerate(doc, 1):
        text = page.get_text("text").strip()
        figs = inset_images(doc, page, image_dir, index)
        image_count += len(figs)
        block = [f"## 第 {index} 页"]
        if len(text) >= TEXT_PAGE:
            text_pages += 1
            block.append(text)
            for fig in figs:
                block.append(f"![第{index}页插图]({fig})")
        else:
            ocr = ""
            png = as_rgb(page.get_pixmap(matrix=fitz.Matrix(1.3, 1.3), alpha=False)).tobytes("png")
            ocr = ocr_png(png)
            if len(ocr) >= TEXT_PAGE:
                text_pages += 1
                block.append(ocr)
            else:
                name = f"page-{index}.jpg"
                if render_page(page, image_dir / name):
                    image_count += 1
                    block.append(f"![第{index}页](images/{name})")
                if text:
                    block.append(text)
                if ocr:
                    block.append(ocr)
                for fig in figs:
                    block.append(f"![第{index}页插图]({fig})")
        parts.append("\n\n".join(block))
    doc.close()
    return {"pages": len(parts), "text_pages": text_pages, "images": image_count, "body": "\n\n".join(parts)}


def slide_text(xml: bytes) -> str:
    root = ET.fromstring(xml)
    lines = [node.text.strip() for node in root.iter("{%s}t" % NS["a"]) if node.text and node.text.strip()]
    return "\n".join(lines)


def slide_media(zipf: zipfile.ZipFile, slide_name: str) -> list[str]:
    rels_name = slide_name.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels"
    if rels_name not in zipf.namelist():
        return []
    root = ET.fromstring(zipf.read(rels_name))
    media = []
    for rel in root:
        target = rel.attrib.get("Target", "")
        if "media/" in target and Path(target).suffix.lower() in {".png", ".jpeg", ".jpg", ".gif", ".emf", ".wmf"}:
            media.append("ppt/" + target.replace("../", ""))
    return media


def convert_pptx(src: Path, out: Path) -> dict:
    image_dir = out / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    parts: list[str] = []
    images = 0
    text_pages = 0
    with zipfile.ZipFile(src) as zipf:
        slides = sorted(
            [n for n in zipf.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)],
            key=lambda n: int(re.search(r"(\d+)", n).group(1)),
        )
        for name in slides:
            number = int(re.search(r"(\d+)", name).group(1))
            text = slide_text(zipf.read(name))
            block = [f"## 第 {number} 张"]
            if len(text) >= 20:
                text_pages += 1
                block.append(text)
            slide_images = 0
            for media in slide_media(zipf, name):
                if media not in zipf.namelist():
                    continue
                ext = Path(media).suffix.lower()
                if ext not in {".png", ".jpg", ".jpeg", ".gif"}:
                    continue
                blob = zipf.read(media)
                if len(blob) < 2048 or len(blob) > MAX_IMAGE_BYTES:
                    continue
                dest_name = f"s{number}-{slide_images + 1}{ext}"
                (image_dir / dest_name).write_bytes(blob)
                slide_images += 1
                images += 1
                block.append(f"![第{number}张插图](images/{dest_name})")
            if len(text) < 20 and slide_images == 0:
                block.append("（此页几乎没有可抽取的文字）")
            parts.append("\n\n".join(block))
    return {"pages": len(parts), "text_pages": text_pages, "images": images, "body": "\n\n".join(parts)}


def convert_docx(src: Path, out: Path) -> dict:
    image_dir = out / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    images = 0
    with zipfile.ZipFile(src) as zipf:
        xml = zipf.read("word/document.xml")
        root = ET.fromstring(xml)
        paras = []
        for para in root.iter("{%s}p" % NS["w"]):
            texts = [node.text for node in para.iter("{%s}t" % NS["w"]) if node.text]
            line = "".join(texts).strip()
            if line:
                paras.append(line)
        for name in zipf.namelist():
            if not name.startswith("word/media/"):
                continue
            ext = Path(name).suffix.lower()
            if ext not in {".png", ".jpg", ".jpeg", ".gif"}:
                continue
            blob = zipf.read(name)
            if len(blob) < 2048 or len(blob) > MAX_IMAGE_BYTES:
                continue
            images += 1
            dest = f"img-{images}{ext}"
            (image_dir / dest).write_bytes(blob)
            paras.append(f"![插图](images/{dest})")
    body = "\n\n".join(paras)
    return {"pages": 1, "text_pages": 1 if len(body) >= TEXT_PAGE else 0, "images": images, "body": body}


def write_doc(meta: dict, converted: dict, out: Path) -> None:
    fm = [
        "---",
        f"title: {meta['title'].replace(chr(10), ' ')}",
        f"parent: {meta['parent'].replace(chr(10), ' ')}",
        f"context: {meta['context'].replace(chr(10), ' ')}",
        f"source: {meta['path']}",
        f"kind: {meta['suffix'].lstrip('.')}",
        "---",
        "",
        f"# {meta['title']}",
        "",
        f"来源：{meta['parent']}",
        "",
        meta["context"],
        "",
        converted["body"],
        "",
    ]
    (out / "doc.md").write_text("\n".join(fm), encoding="utf-8")


def main() -> int:
    sources = load_sources()
    OUT.mkdir(parents=True, exist_ok=True)
    catalog = []
    ok = skip = fail = 0
    print(f"sources {len(sources)}", flush=True)
    for index, meta in enumerate(sources, 1):
        src = ROOT / meta["path"]
        out = OUT / doc_id(meta["path"])
        dest = out / "doc.md"
        if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
            skip += 1
            catalog.append({"id": out.name, "title": meta["title"], "path": str(dest.relative_to(ROOT)), "source": meta["path"]})
            continue
        # 扫描教材识别超时后只会留下整页图，正文无法检索。
        if "数理统计" in meta["title"] and "韦来生" in meta["title"]:
            skip += 1
            print(f"[{index}/{len(sources)}] skip {meta['title']}", flush=True)
            continue
        print(f"[{index}/{len(sources)}] {meta['title']}", flush=True)
        try:
            meta["context"] = parent_context(meta["token"], meta["parent"])
            out.mkdir(parents=True, exist_ok=True)
            if meta["suffix"] == ".pdf":
                converted = convert_pdf(src, out)
            elif meta["suffix"] == ".pptx":
                converted = convert_pptx(src, out)
            else:
                converted = convert_docx(src, out)
            write_doc(meta, converted, out)
            ok += 1
            catalog.append({
                "id": out.name,
                "title": meta["title"],
                "parent": meta["parent"],
                "path": str(dest.relative_to(ROOT)),
                "source": meta["path"],
                "pages": converted["pages"],
                "text_pages": converted["text_pages"],
                "images": converted["images"],
            })
        except Exception as exc:  # noqa: BLE001
            fail += 1
            print(f"  FAIL {exc}", flush=True)
    (OUT / "catalog.json").write_text(json.dumps({"docs": catalog}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"ok {ok}  skipped {skip}  fail {fail}", flush=True)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
