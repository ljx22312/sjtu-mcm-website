#!/usr/bin/env python3
"""下载讲义 Markdown 里内嵌的附件和图片到 data/knowledge/embedded/。

这些 token 不在课程表的资源列里，只出现在云文档正文的 <source> / <img> 上。
lark-cli 不能直接写到 /root，先下到临时目录再搬进来。已存在且大小吻合的文件会跳过。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "data/knowledge/docs"
OUT_DIR = ROOT / "data/knowledge/embedded"
MANIFEST = ROOT / "data/knowledge/embedded-manifest.json"

ATTR = re.compile(r'(\w[\w-]*)="([^"]*)"')
SOURCE = re.compile(r"<source\b([^>]*)/?>")
IMG = re.compile(r"<img\b([^>]*)/?>")


def attrs(blob: str) -> dict[str, str]:
    return {k: v for k, v in ATTR.findall(blob)}


def safe_name(name: str) -> str:
    cleaned = re.sub(r"[^\w.\-一-鿿]+", "_", name).strip("._")
    return cleaned[:80] or "file"


def collect() -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    for md in sorted(DOCS_DIR.glob("*.md")):
        text = md.read_text(encoding="utf-8", errors="replace")
        title = ""
        for line in text.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        for kind, pattern, token_key in (
            ("file", SOURCE, "token"),
            ("image", IMG, "src"),
        ):
            for match in pattern.finditer(text):
                meta = attrs(match.group(1))
                token = meta.get(token_key) or ""
                if not token or token in seen:
                    continue
                seen.add(token)
                name = meta.get("name") or ("image.png" if kind == "image" else token)
                size = int(meta.get("size") or 0)
                items.append(
                    {
                        "kind": kind,
                        "doc": md.stem,
                        "doc_title": title,
                        "name": name,
                        "token": token,
                        "declared_bytes": size,
                        "mime": meta.get("mime") or "",
                    }
                )
    return items


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
        raise RuntimeError((proc.stderr or proc.stdout or "lark-cli 无输出")[:400])
    data, _ = json.JSONDecoder().raw_decode(raw[start:])
    if not data.get("ok", True) and data.get("error"):
        err = data["error"]
        raise RuntimeError(err.get("message") or json.dumps(err, ensure_ascii=False)[:400])
    return data


def download(token: str, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="kb-embed-") as tmp:
        staged = Path(tmp) / dest.name
        data = run_lark(
            [
                "docs",
                "+media-download",
                "--as",
                "user",
                "--type",
                "media",
                "--token",
                token,
                "--output",
                str(staged),
                "--overwrite",
            ]
        )
        saved = Path((data.get("data") or {}).get("saved_path") or staged)
        if not saved.exists():
            raise RuntimeError("下载未产生文件")
        shutil.move(str(saved), dest)
        size = (data.get("data") or {}).get("size_bytes") or dest.stat().st_size
    return int(size)


def main() -> int:
    items = collect()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    ok = fail = skipped = 0
    print(f"embedded items: {len(items)}", flush=True)
    for i, item in enumerate(items, 1):
        dest = OUT_DIR / item["doc"] / f"{item['token']}_{safe_name(item['name'])}"
        rel = str(dest.relative_to(ROOT))
        expected = item["declared_bytes"]
        if dest.exists() and dest.stat().st_size > 0 and (expected == 0 or dest.stat().st_size == expected):
            skipped += 1
            results.append({**item, "ok": True, "skipped": True, "path": rel, "bytes": dest.stat().st_size})
            continue
        print(f"[{i}/{len(items)}] {item['kind']} {item['name']}", flush=True)
        last_err = ""
        saved_bytes = 0
        for attempt in range(3):
            try:
                saved_bytes = download(item["token"], dest)
                last_err = ""
                break
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)
                time.sleep(1.5 * (attempt + 1))
        if last_err:
            fail += 1
            print(f"  FAIL {last_err}", flush=True)
            results.append({**item, "ok": False, "error": last_err})
        else:
            ok += 1
            results.append({**item, "ok": True, "path": rel, "bytes": saved_bytes})
    manifest = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "ok": ok,
        "skipped": skipped,
        "fail": fail,
        "items": results,
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"ok {ok}  skipped {skipped}  fail {fail}", flush=True)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
