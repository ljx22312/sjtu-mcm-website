#!/usr/bin/env python3
"""把知识库里的非视频资料从飞书镜像到 data/knowledge/，供站内 agent 阅读。

云文档（wiki / docx）用 docs +fetch 存成 Markdown。
表格附件用 drive +preview --type source_file 存原文件（直接 download 会 403）。
妙记、腾讯会议回放等视频链接不下载。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_FILES = [
    ROOT / "src/data/cumcm-curriculum.json",
    ROOT / "src/data/mcm-curriculum.json",
]
OUT = ROOT / "data/knowledge"
DOCS_DIR = OUT / "docs"
FILES_DIR = OUT / "files"


def load_items():
    docs: dict[str, dict] = {}
    files: dict[str, dict] = {}
    skipped_video = 0
    for path in DATA_FILES:
        track = "cumcm" if "cumcm" in path.name else "mcm"
        payload = json.loads(path.read_text())
        for item in payload["items"]:
            ref = {
                "track": track,
                "course_id": item.get("course_id") or "",
                "topic": item.get("topic") or "",
                "module": item.get("module") or "",
            }
            for res in item.get("resources") or []:
                url = (res.get("url") or "").split("?")[0]
                name = res.get("name") or ""
                if "/minutes/" in url or "meeting.tencent.com" in url:
                    skipped_video += 1
                    continue
                if "feishu.cn" in url and ("/docx/" in url or "/wiki/" in url):
                    entry = docs.setdefault(
                        url,
                        {"url": url, "names": [], "courses": []},
                    )
                    if name and name not in entry["names"]:
                        entry["names"].append(name)
                    entry["courses"].append({**ref, "resource_name": name})
                    continue
                if res.get("type") == "attachment" and res.get("token"):
                    token = res["token"]
                    entry = files.setdefault(
                        token,
                        {
                            "token": token,
                            "name": name,
                            "size_kb": res.get("size_kb"),
                            "courses": [],
                        },
                    )
                    entry["courses"].append({**ref, "resource_name": name})
    return docs, files, skipped_video


def run_lark(args: list[str]) -> dict:
    proc = subprocess.run(
        ["lark-cli", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    raw = proc.stdout if "{" in (proc.stdout or "") else "\n".join(
        part for part in (proc.stdout, proc.stderr) if part
    )
    start = raw.find("{")
    if start < 0:
        raise RuntimeError((proc.stderr or proc.stdout or "lark-cli 无输出")[:500])
    data, _ = json.JSONDecoder().raw_decode(raw[start:])
    if not data.get("ok", True) and data.get("error"):
        err = data["error"]
        raise RuntimeError(err.get("message") or json.dumps(err, ensure_ascii=False)[:400])
    if proc.returncode != 0 and not data.get("ok"):
        raise RuntimeError((proc.stderr or raw)[:500])
    return data


def safe_name(name: str) -> str:
    cleaned = re.sub(r"[^\w.\-一-鿿]+", "_", name).strip("._")
    return cleaned[:80] or "file"


def fetch_doc(url: str, dest: Path) -> dict:
    data = run_lark(
        [
            "docs",
            "+fetch",
            "--as",
            "user",
            "--doc",
            url,
            "--doc-format",
            "markdown",
            "--scope",
            "full",
        ]
    )
    document = data.get("data", {}).get("document") or {}
    content = document.get("content") or ""
    if not content.strip():
        raise RuntimeError("文档正文为空")
    title = ""
    for line in content.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            break
    text_only = re.sub(r"<[^>]+>", " ", content)
    dest.write_text(content, encoding="utf-8")
    return {
        "title": title,
        "document_id": document.get("document_id"),
        "revision_id": document.get("revision_id"),
        "bytes": dest.stat().st_size,
        "chars": len(text_only),
        "images": len(re.findall(r"<img\b", content)),
    }


def download_file(token: str, dest: Path) -> dict:
    # lark-cli 拒绝把文件直接写进 /root，先落到临时目录再搬进项目。
    with tempfile.TemporaryDirectory(prefix="kb-file-") as tmp:
        staged = Path(tmp) / dest.name
        data = run_lark(
            [
                "drive",
                "+preview",
                "--as",
                "user",
                "--file-token",
                token,
                "--type",
                "source_file",
                "--output",
                str(staged),
                "--if-exists",
                "overwrite",
            ]
        )
        if not staged.exists():
            raise RuntimeError("预览下载未产生文件")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staged), dest)
    info = data.get("data") or {}
    return {
        "bytes": info.get("size_bytes") or dest.stat().st_size,
        "content_type": info.get("content_type"),
    }


def main() -> int:
    docs, files, skipped_video = load_items()
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)

    doc_results = []
    for i, (url, meta) in enumerate(sorted(docs.items()), 1):
        token = url.rstrip("/").split("/")[-1]
        dest = DOCS_DIR / f"{token}.md"
        print(f"[doc {i}/{len(docs)}] {meta['names'][:1]}", flush=True)
        try:
            info = fetch_doc(url, dest)
            doc_results.append({**meta, "token": token, "path": str(dest.relative_to(ROOT)), "ok": True, **info})
        except Exception as exc:  # noqa: BLE001 — 单篇失败不中断整批
            print(f"  FAIL {exc}", flush=True)
            doc_results.append({**meta, "token": token, "ok": False, "error": str(exc)})

    file_results = []
    for i, (token, meta) in enumerate(sorted(files.items()), 1):
        dest = FILES_DIR / f"{token}_{safe_name(meta['name'])}"
        print(f"[file {i}/{len(files)}] {meta['name']}", flush=True)
        try:
            info = download_file(token, dest)
            file_results.append({**meta, "path": str(dest.relative_to(ROOT)), "ok": True, **info})
        except Exception as exc:  # noqa: BLE001
            print(f"  FAIL {exc}", flush=True)
            file_results.append({**meta, "ok": False, "error": str(exc)})

    manifest = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "skipped_video_links": skipped_video,
        "docs": doc_results,
        "files": file_results,
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    ok_docs = sum(1 for d in doc_results if d.get("ok"))
    ok_files = sum(1 for f in file_results if f.get("ok"))
    print(f"docs {ok_docs}/{len(doc_results)}  files {ok_files}/{len(file_results)}  skipped_video {skipped_video}")
    return 0 if ok_docs == len(doc_results) and ok_files == len(file_results) else 1


if __name__ == "__main__":
    sys.exit(main())
