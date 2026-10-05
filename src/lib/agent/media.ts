/**
 * 只读打开知识库里的图片。路径必须落在 data/knowledge 的 readable 或 embedded 下。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

const MAX_BYTES = 900_000;

function textResult(text: string): AgentToolResult<string> {
  return { content: [{ type: "text", text }], details: text };
}

function mimeOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function shrinkJpeg(abs: string): Buffer | null {
  const proc = spawnSync(
    "python3",
    [
      "-c",
      `import sys
from io import BytesIO
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
for side in (1600, 1200, 900, 720):
    copy = im
    if max(im.size) > side:
        copy = im.copy()
        copy.thumbnail((side, side))
    for quality in (70, 55, 40):
        buf = BytesIO()
        copy.save(buf, "JPEG", quality=quality, optimize=True)
        if buf.tell() <= 900_000:
            sys.stdout.buffer.write(buf.getvalue())
            raise SystemExit(0)
raise SystemExit(1)
`,
      abs,
    ],
    { maxBuffer: 2_000_000 },
  );
  if (proc.status !== 0 || !proc.stdout?.length) return null;
  return proc.stdout;
}

/** 读取一张资料图，并把图像交给多模态模型。 */
export function readKnowledgeImage(ref: string): AgentToolResult<string> {
  const rel = ref.trim().replace(/^data\/knowledge\//, "").replace(/^\.\//, "");
  const root = resolve(process.cwd(), "data", "knowledge");
  const abs = resolve(root, rel);
  const allowed = abs.startsWith(root + sep + "readable" + sep) || abs.startsWith(root + sep + "embedded" + sep);
  if (!allowed || !/\.(png|jpe?g|gif|webp)$/i.test(abs)) {
    return textResult("图片路径无效。请使用资料正文里的 readable/.../images/... 或 embedded/... 路径。");
  }
  if (/\/page-\d+\.(?:jpe?g|png)$/i.test(abs)) {
    return textResult("这是整页扫描截图，不适合交给模型逐页看。请根据同一份资料的正文回答；正文里没有的内容就说明讲义里没有。");
  }
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    return textResult("没有这张图片。");
  }
  const where = rel;
  let data: string;
  let mime = mimeOf(abs);
  if (size > MAX_BYTES) {
    const shrunk = shrinkJpeg(abs);
    if (!shrunk) {
      return textResult(`图片 ${where} 有 ${Math.round(size / 1024)}KB，缩小后仍放不下。请根据同一段文字回答，不要编造图中内容。`);
    }
    data = shrunk.toString("base64");
    mime = "image/jpeg";
  } else {
    data = readFileSync(abs).toString("base64");
  }
  const image: ImageContent = { type: "image", data, mimeType: mime };
  const text = `这是资料图片 ${where}。只描述你实际看到的内容，看不清就说看不清。`;
  return { content: [{ type: "text", text }, image], details: text };
}
