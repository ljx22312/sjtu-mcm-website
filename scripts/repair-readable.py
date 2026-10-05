#!/usr/bin/env python3
"""补全已转换文稿的三处缺口，不重新 OCR。

1. 去掉 doc.md 开头邻近原文里残留的 XML。
2. 把上次因高度不足 48pt 被丢掉的扁公式图裁出来，接到对应的 (n) 前面。
3. 按字体里的真实字形名修正公式（η、κ、ff 这类），补上被 ToUnicode 丢掉的字母，
   并用字号标出上下标。映射后仍是乱码、或同一字母被多个编码撞车的，改成小图。

已写好的页若源 PDF 不再含这些情况，正文保持原样。可以重复运行。
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

import fitz

ROOT = Path("/root/sjtu-mcm-website")
READABLE = ROOT / "data" / "knowledge" / "readable"
MAX_IMAGE_BYTES = 900_000

LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
}
BAD_CHARS = set("\u21b5\u2318\uf8ff\ufffd\u21e2\u21e5\u0000")

# 字形名 → 写进 Markdown 的文本。只收公式和连字里常见的名字。
GLYPH = {
    "space": " ",
    "nbspace": " ",
    "period": ".",
    "comma": ",",
    "colon": ":",
    "semicolon": ";",
    "slash": "/",
    "equal": "=",
    "plus": "+",
    "minus": "−",
    "hyphen": "-",
    "less": "<",
    "greater": ">",
    "parenleft": "(",
    "parenright": ")",
    "bracketleft": "[",
    "bracketright": "]",
    "braceleft": "{",
    "braceright": "}",
    "percent": "%",
    "asterisk": "*",
    "numbersign": "#",
    "ampersand": "&",
    "at": "@",
    "exclam": "!",
    "question": "?",
    "quotesingle": "'",
    "quotedbl": '"',
    "prime": "′",
    "second": "″",
    "periodcentered": "·",
    "bullet": "•",
    "openbullet": "◦",
    "degree": "°",
    "multiply": "×",
    "divide": "÷",
    "plusminus": "±",
    "minusplus": "∓",
    "lessequal": "≤",
    "greaterequal": "≥",
    "notequal": "≠",
    "approxequal": "≈",
    "equivalence": "≡",
    "similar": "∼",
    "proportional": "∝",
    "infinity": "∞",
    "partialdiff": "∂",
    "summation": "∑",
    "product": "∏",
    "integral": "∫",
    "radical": "√",
    "nabla": "∇",
    "emptyset": "∅",
    "element": "∈",
    "notelement": "∉",
    "propersubset": "⊂",
    "propersuperset": "⊃",
    "reflexsubset": "⊆",
    "reflexsuperset": "⊇",
    "universal": "∀",
    "existential": "∃",
    "therefore": "∴",
    "arrowleft": "←",
    "arrowright": "→",
    "arrowboth": "↔",
    "arrowup": "↑",
    "arrowdown": "↓",
    "logicalnot": "¬",
    "logicaland": "∧",
    "logicalor": "∨",
    "dotmath": "⋅",
    "ff": "ff",
    "fi": "fi",
    "fl": "fl",
    "ffi": "ffi",
    "ffl": "ffl",
    "alpha": "α",
    "beta": "β",
    "gamma": "γ",
    "delta": "δ",
    "epsilon": "ε",
    "zeta": "ζ",
    "eta": "η",
    "theta": "θ",
    "iota": "ι",
    "kappa": "κ",
    "lambda": "λ",
    "mu": "μ",
    "nu": "ν",
    "xi": "ξ",
    "pi": "π",
    "rho": "ρ",
    "sigma": "σ",
    "tau": "τ",
    "upsilon": "υ",
    "phi": "φ",
    "chi": "χ",
    "psi": "ψ",
    "omega": "ω",
    "Alpha": "Α",
    "Beta": "Β",
    "Gamma": "Γ",
    "Delta": "Δ",
    "Epsilon": "Ε",
    "Zeta": "Ζ",
    "Eta": "Η",
    "Theta": "Θ",
    "Iota": "Ι",
    "Kappa": "Κ",
    "Lambda": "Λ",
    "Mu": "Μ",
    "Nu": "Ν",
    "Xi": "Ξ",
    "Pi": "Π",
    "Rho": "Ρ",
    "Sigma": "Σ",
    "Tau": "Τ",
    "Upsilon": "Υ",
    "Phi": "Φ",
    "Chi": "Χ",
    "Psi": "Ψ",
    "Omega": "Ω",
    "varepsilon": "ε",
    "vartheta": "ϑ",
    "varpi": "ϖ",
    "varrho": "ϱ",
    "varsigma": "ς",
    "varphi": "ϕ",
}


def clean_neighbor(window: str) -> str:
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
    has_year_or_cjk = re.search(r"\d{4}|[\u4e00-\u9fff]", window)
    words = re.findall(r"[A-Za-z]{3,}", window)
    if not has_year_or_cjk and len(words) < 2:
        return ""
    return window[:180]


def polish_text(text: str) -> str:
    """把粘到页标题上的上下文拆开，并再清一次邻近原文。"""
    text = re.sub(r"([^\n])(## 第 \d+ (?:页|张))", r"\1\n\n\2", text)
    lines = []
    for line in text.splitlines():
        if line.startswith("context:"):
            lines.append("context: " + clean_context_line(line.split(":", 1)[1].strip()))
        elif "邻近原文" in line and not line.startswith("#"):
            lines.append(clean_context_line(line.strip()))
        else:
            lines.append(line)
    suffix = "\n" if text.endswith("\n") else ""
    return "\n".join(lines) + suffix


def clean_context_line(line: str) -> str:
    if "邻近原文：" not in line:
        return line.replace("\ufffd", " ").strip()
    head, _, tail = line.partition("邻近原文：")
    tail = clean_neighbor(tail)
    head = head.strip()
    if not tail:
        return head.rstrip("。")
    return f"{head.rstrip('。')}。邻近原文：{tail}"


def plain(text: str) -> str:
    """丢掉孤立的 UTF-16 代理项，避免写 Markdown 时崩溃。"""
    if not text:
        return ""
    out = []
    for char in text:
        code = ord(char)
        if 0xD800 <= code <= 0xDFFF:
            out.append("\ufffd")
        else:
            out.append(char)
    return "".join(out)


def fold_math(ch: str) -> str:
    if len(ch) != 1:
        return ch
    o = ord(ch)
    blocks = (
        (0x1D400, 0x1D419, "A"),
        (0x1D41A, 0x1D433, "a"),
        (0x1D434, 0x1D44D, "A"),
        (0x1D44E, 0x1D467, "a"),
        (0x1D468, 0x1D481, "A"),
        (0x1D482, 0x1D49B, "a"),
        (0x1D4D0, 0x1D4E9, "A"),
        (0x1D4EA, 0x1D503, "a"),
        (0x1D56C, 0x1D585, "A"),
        (0x1D586, 0x1D59F, "a"),
        (0x1D5A0, 0x1D5B9, "A"),
        (0x1D5BA, 0x1D5D3, "a"),
        (0x1D5D4, 0x1D5ED, "A"),
        (0x1D5EE, 0x1D607, "a"),
        (0x1D608, 0x1D621, "A"),
        (0x1D622, 0x1D63B, "a"),
        (0x1D63C, 0x1D655, "A"),
        (0x1D656, 0x1D66F, "a"),
        (0x1D670, 0x1D689, "A"),
        (0x1D68A, 0x1D6A3, "a"),
        (0x1D7CE, 0x1D7D7, "0"),
        (0x1D7D8, 0x1D7E1, "0"),
        (0x1D7E2, 0x1D7EB, "0"),
        (0x1D7EC, 0x1D7F5, "0"),
        (0x1D7F6, 0x1D7FF, "0"),
    )
    for start, end, base in blocks:
        if start <= o <= end:
            return chr(ord(base) + (o - start))
    return LIGATURES.get(ch, ch)


def expand_ligatures(text: str) -> str:
    for src, dst in LIGATURES.items():
        text = text.replace(src, dst)
    return text


def parse_differences(obj: str) -> dict[int, str]:
    match = re.search(r"/Differences\s*\[(.*?)\]", obj, re.S)
    if not match:
        return {}
    mapping: dict[int, str] = {}
    code = None
    for name, num in re.findall(r"/([A-Za-z0-9.]+)|(-?\d+)", match.group(1)):
        if num:
            code = int(num)
        elif name and code is not None:
            mapping[code] = name
            code += 1
    return mapping


def parse_widths(obj: str) -> tuple[int, list[int]]:
    first = re.search(r"/FirstChar\s+(\d+)", obj)
    widths = re.search(r"/Widths\s*\[(.*?)\]", obj, re.S)
    if not first or not widths:
        return 0, []
    values = [int(float(n)) for n in re.findall(r"-?\d+", widths.group(1))]
    return int(first.group(1)), values


def parse_tounicode(data: bytes) -> dict[int, str]:
    text = data.decode("latin1", errors="replace")
    out: dict[int, str] = {}

    def decode(hex_text: str) -> str:
        raw = bytes.fromhex(hex_text)
        if raw.startswith(b"\xfe\xff"):
            raw = raw[2:]
        if len(raw) % 2:
            return ""
        chars = raw.decode("utf-16-be", errors="replace").replace("\x00", "")
        if len(chars) >= 2 and len(chars) % 2 == 0 and chars[: len(chars) // 2] == chars[len(chars) // 2 :]:
            chars = chars[: len(chars) // 2]
        return chars

    for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", text):
        if len(src) <= 4:
            out[int(src, 16)] = decode(dst)
    return out


def ugly_unicode(text: str | None) -> bool:
    if text is None:
        return False
    if text == "":
        return True
    for char in text:
        code = ord(char)
        if char in BAD_CHARS or 0xE000 <= code <= 0xF8FF or 0xD800 <= code <= 0xDFFF:
            return True
    return False


def overlay_needed(correct: str, current: str | None) -> bool:
    """只改写抽出来已经是乱码的字形。正文里本来就对的标点和 fi 连字不动。"""
    if correct in {"ff", "fi", "fl", "ffi", "ffl"} and not ugly_unicode(current):
        return False
    if current is None:
        return any(ord(char) > 127 for char in correct)
    return ugly_unicode(current)


def font_db(doc: fitz.Document, page: fitz.Page) -> dict[str, dict]:
    """资源名 Ty11 → 字体信息。同时按基础名索引。"""
    by_ref: dict[str, dict] = {}
    by_base: dict[str, dict] = {}
    for xref, _ext, subtype, name, ref, encoding in page.get_fonts():
        obj = doc.xref_object(xref)
        enc_ref = re.search(r"/Encoding\s+(\d+)\s+0\s+R", obj)
        enc_obj = doc.xref_object(int(enc_ref.group(1))) if enc_ref else obj
        differences = parse_differences(enc_obj)
        if not differences:
            differences = parse_differences(obj)
        first, widths = parse_widths(obj)
        tu_ref = re.search(r"/ToUnicode\s+(\d+)\s+0\s+R", obj)
        tounicode: dict[int, str] = {}
        collided: set[str] = set()
        if tu_ref:
            try:
                tounicode = parse_tounicode(doc.xref_stream(int(tu_ref.group(1))))
            except Exception:
                tounicode = {}
            reverse: dict[str, set[int]] = defaultdict(set)
            for code, chars in tounicode.items():
                if len(chars) == 1:
                    reverse[chars].add(code)
                    reverse[fold_math(chars)].add(code)
            collided = {ch for ch, codes in reverse.items() if len(codes) >= 2 and len(ch) == 1}
        decoded = {}
        for code, glyph in differences.items():
            text = GLYPH.get(glyph)
            if text and overlay_needed(text, tounicode.get(code)):
                decoded[code] = text
        info = {
            "ref": ref,
            "base": name.split("+")[-1],
            "xref": xref,
            "cid": subtype == "Type0" or encoding in {"Identity-H", "Identity-V"},
            "first": first,
            "widths": widths,
            "decoded": decoded,
            "collided": collided,
            "special": bool(decoded),
        }
        by_ref[ref] = info
        # 同一页可能有两套同名子集。特殊编码覆盖普通的。
        previous = by_base.get(info["base"])
        if previous is None or (info["special"] and not previous["special"]):
            by_base[info["base"]] = info
        elif previous["special"] and info["special"]:
            merged = dict(previous["decoded"])
            merged.update(info["decoded"])
            previous["decoded"] = merged
            previous["collided"] |= info["collided"]
    return {"ref": by_ref, "base": by_base}


def parse_literal(text: str, index: int) -> tuple[bytes, int]:
    index += 1
    out = bytearray()
    while index < len(text):
        char = text[index]
        if char == ")":
            return bytes(out), index + 1
        if char == "\\":
            nxt = text[index + 1] if index + 1 < len(text) else ""
            named = {"n": 10, "r": 13, "t": 9, "b": 8, "f": 12}
            if nxt in named:
                out.append(named[nxt])
                index += 2
            elif nxt in "()\\":
                out.append(ord(nxt))
                index += 2
            elif nxt.isdigit():
                octal = nxt
                cursor = index + 2
                while cursor < len(text) and cursor < index + 4 and text[cursor].isdigit():
                    octal += text[cursor]
                    cursor += 1
                out.append(int(octal, 8) & 255)
                index = cursor
            elif nxt == "\n":
                index += 2
            else:
                index += 2
            continue
        out.append(ord(char))
        index += 1
    return bytes(out), index


def skip_dict(text: str, index: int) -> int:
    depth = 0
    while index < len(text):
        if text.startswith("<<", index):
            depth += 1
            index += 2
            continue
        if text.startswith(">>", index):
            depth -= 1
            index += 2
            if depth == 0:
                return index
            continue
        if text[index] == "(":
            _, index = parse_literal(text, index)
            continue
        index += 1
    return index


def content_glyphs(page: fitz.Page, fonts: dict) -> list[dict]:
    """抽出使用了自定义编码的字形，坐标与 PyMuPDF 的 origin 对齐。"""
    raw = page.read_contents()
    if not raw:
        return []
    text = raw.decode("latin1", errors="replace")
    by_ref = fonts["ref"]
    glyphs = []
    stack: list[tuple] = []
    gstack: list[dict] = []
    state = {"font": None, "size": 1.0, "tm": [1, 0, 0, 1, 0, 0], "ctm": [1, 0, 0, 1, 0, 0]}
    index = 0
    length = len(text)

    def device_xy() -> tuple[float, float]:
        a, b, c, d, e, f = state["tm"]
        A, B, C, D, E, F = state["ctm"]
        return a * 0 + e * A + f * C + E, e * B + f * D + F

    def width_of(info: dict, code: int) -> float:
        first = info["first"]
        widths = info["widths"]
        if widths and 0 <= code - first < len(widths):
            return widths[code - first]
        return 500

    def show(data: bytes, hex_string: bool = False):
        info = by_ref.get(state["font"] or "")
        if info is None or not data:
            return
        size = abs(state["tm"][0]) * (state["size"] or 1)
        if size < 0.2:
            size = state["size"] or 1
        x, y = device_xy()
        step = 2 if info["cid"] else 1
        cursor = 0
        while cursor + step <= len(data):
            if info["cid"]:
                code = (data[cursor] << 8) | data[cursor + 1]
            else:
                code = data[cursor]
            if info["special"] and code in info["decoded"]:
                glyphs.append(
                    {
                        "font": info["base"],
                        "text": info["decoded"][code],
                        "x": x,
                        "y": y,
                        "size": size,
                    }
                )
            advance = width_of(info, code) / 1000 * size
            x += advance
            state["tm"][4] = x if state["ctm"] == [1, 0, 0, 1, 0, 0] else state["tm"][4] + advance
            # 身份 CTM 时 device x 就是 tm.e。有缩放时只累加 tm.e，避免重复乘。
            if state["ctm"] == [1, 0, 0, 1, 0, 0]:
                state["tm"][4] = x
            cursor += step
        if state["ctm"] == [1, 0, 0, 1, 0, 0]:
            state["tm"][4] = x

    while index < length:
        char = text[index]
        if char.isspace():
            index += 1
            continue
        if char == "%":
            nxt = text.find("\n", index)
            index = length if nxt < 0 else nxt + 1
            continue
        if char == "<" and index + 1 < length and text[index + 1] == "<":
            index = skip_dict(text, index)
            continue
        if char == "(":
            data, index = parse_literal(text, index)
            stack.append(("s", data))
            continue
        if char == "<":
            end = text.find(">", index)
            if end < 0:
                break
            hex_text = re.sub(r"\s+", "", text[index + 1 : end])
            if len(hex_text) % 2:
                hex_text += "0"
            try:
                data = bytes.fromhex(hex_text)
            except ValueError:
                data = b""
            stack.append(("s", data))
            index = end + 1
            continue
        if char == "[":
            stack.append(("[", None))
            index += 1
            continue
        if char == "]":
            stack.append(("]", None))
            index += 1
            continue
        if char == "/":
            end = index + 1
            while end < length and text[end] not in " \t\r\n[]()<>{}/%":
                end += 1
            stack.append(("n", text[index + 1 : end]))
            index = end
            continue
        if char in "0123456789+-.":
            end = index + 1
            while end < length and text[end] in "0123456789.":
                end += 1
            try:
                number = float(text[index:end])
            except ValueError:
                index = end
                continue
            stack.append(("f", number))
            index = end
            continue
        end = index
        while end < length and text[end] not in " \t\r\n[]()<>{}/%":
            end += 1
        op = text[index:end]
        if not op:
            index += 1
            continue
        index = end
        if op == "q":
            gstack.append({k: (v[:] if isinstance(v, list) else v) for k, v in state.items()})
            stack.clear()
        elif op == "Q" and gstack:
            state = gstack.pop()
            stack.clear()
        elif op == "cm" and len(stack) >= 6:
            nums = [stack.pop()[1] for _ in range(6)]
            nums.reverse()
            a, b, c, d, e, f = nums
            A, B, C, D, E, F = state["ctm"]
            state["ctm"] = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F]
            stack.clear()
        elif op == "BT":
            state["tm"] = [1, 0, 0, 1, 0, 0]
            stack.clear()
        elif op == "ET":
            stack.clear()
        elif op == "Tm" and len(stack) >= 6:
            nums = [stack.pop()[1] for _ in range(6)]
            nums.reverse()
            state["tm"] = nums
            stack.clear()
        elif op == "Td" and len(stack) >= 2:
            ty = stack.pop()[1]
            tx = stack.pop()[1]
            state["tm"][4] += tx
            state["tm"][5] += ty
            stack.clear()
        elif op == "Tf" and len(stack) >= 2:
            state["size"] = stack.pop()[1]
            state["font"] = stack.pop()[1]
            stack.clear()
        elif op == "Tj" and stack and stack[-1][0] == "s":
            show(stack.pop()[1])
            stack.clear()
        elif op == "TJ":
            array = []
            while stack:
                item = stack.pop()
                if item[0] == "[":
                    break
                array.append(item)
            array.reverse()
            info = by_ref.get(state["font"] or "")
            size = abs(state["tm"][0]) * (state["size"] or 1) or 1
            for item in array:
                if item[0] == "s":
                    show(item[1])
                elif item[0] == "f" and info is not None:
                    state["tm"][4] -= item[1] / 1000 * size
            stack.clear()
        else:
            stack.clear()
    return glyphs


def median(values: list[float]) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def dedupe_chars(chars: list[dict]) -> list[dict]:
    """去掉 ToUnicode 把一个字形写成两次留下的空壳。

    ff/fi 连字在 TeX 字体里是「宽的 f + 右边零宽的第二个 f」。
    那第二个 f 是真字母，不能当成空壳丢掉。空壳只出现在同一位置，
    或者数学字母（CambriaMath）的零宽孪生。
    """
    kept = []
    for char in chars:
        width = char["bbox"][2] - char["bbox"][0]
        if kept and char["c"] == kept[-1]["c"]:
            prev = kept[-1]
            prev_w = prev["bbox"][2] - prev["bbox"][0]
            same_spot = abs(char["origin"][0] - prev["origin"][0]) < 0.8 and abs(char["origin"][1] - prev["origin"][1]) < 0.8
            code = ord(char["c"][0]) if char["c"] else 0
            math_twin = code >= 0x1D400 or code > 127
            ghost = math_twin and (width < 0.4 or prev_w < 0.4)
            near = abs(char["origin"][1] - prev["origin"][1]) < 0.8 and abs(char["origin"][0] - prev["origin"][0]) < 8
            if same_spot or (ghost and near):
                if prev_w < 0.4 <= width:
                    kept[-1] = char
                continue
        kept.append(char)
    return kept


def line_needs_rebuild(line: dict, fonts: dict) -> bool:
    bases = fonts["base"]
    for span in line["spans"]:
        base = span["font"].split("+")[-1]
        info = bases.get(base)
        if info and (info["special"] or info["collided"]):
            return True
    sizes = [span["size"] for span in line["spans"] if span.get("chars") or span.get("text")]
    if sizes and max(sizes) - min(sizes) >= 2:
        return True
    for span in line["spans"]:
        text = span.get("text") or "".join(char["c"] for char in span.get("chars") or [])
        if any(ch in BAD_CHARS or "\ue000" <= ch <= "\uf8ff" for ch in text):
            return True
        chars = span.get("chars")
        if chars and len(dedupe_chars(chars)) < len(chars):
            return True
    return False


def apply_overlay(lines: list[dict], glyphs: list[dict], page_height: float) -> None:
    pool = []
    for line in lines:
        for span in line["spans"]:
            base = span["font"].split("+")[-1]
            for char in span["chars"]:
                pool.append((base, char))
    used = set()
    for glyph in glyphs:
        # 内容流坐标会偏 3pt 左右，最近的字符常常是前面的空格。
        # 只替换乱码，或者认领 8pt 内已经相同的字符，避免把空格改成 #。
        chosen = None
        for index, (base, char) in enumerate(pool):
            if index in used or base != glyph["font"]:
                continue
            dist = abs(glyph["x"] - char["origin"][0]) + abs(glyph["y"] - (page_height - char["origin"][1]))
            current = plain(char["c"])
            same = current == glyph["text"]
            bad = ugly_unicode(current)
            if same and dist <= 8:
                rank = (0 if dist <= 1.5 else 1, dist)
            elif bad and dist <= 6:
                rank = (0, dist)
            else:
                continue
            if chosen is None or rank < chosen[0]:
                chosen = (rank, index, same)
        if chosen is None:
            glyph["placed"] = False
            continue
        _, index, same = chosen
        if not same:
            pool[index][1]["c"] = glyph["text"]
            pool[index][1]["_fixed"] = True
        used.add(index)
        glyph["placed"] = True


def insert_missing(lines: list[dict], glyphs: list[dict], page_height: float) -> None:
    for glyph in glyphs:
        if glyph.get("placed"):
            continue
        # 单个 ASCII 抽文本来就有，位置对不上时不要再插一份。
        if len(glyph["text"]) == 1 and glyph["text"].isascii():
            continue
        target_y = page_height - glyph["y"]
        best = None
        best_dist = 10**9
        for line in lines:
            origins = [c["origin"][1] for sp in line["spans"] for c in sp["chars"]]
            if not origins:
                continue
            dist = abs(median(origins) - target_y)
            if dist < best_dist:
                best_dist = dist
                best = line
        if best is None or best_dist > 4:
            continue
        synthetic = {
            "c": glyph["text"],
            "origin": (glyph["x"], target_y),
            "bbox": (glyph["x"], target_y - glyph["size"] * 0.8, glyph["x"] + glyph["size"] * 0.45, target_y + glyph["size"] * 0.2),
            "_fixed": True,
            "_size": glyph["size"],
            "_font": glyph["font"],
        }
        if not best["spans"]:
            continue
        placed_at = None
        for span in best["spans"]:
            for char_index, char in enumerate(span["chars"]):
                if char["origin"][0] > glyph["x"] + 0.4:
                    span["chars"].insert(char_index, synthetic)
                    placed_at = True
                    break
            if placed_at:
                break
        if not placed_at:
            best["spans"][-1]["chars"].append(synthetic)


def emit_lines(page: fitz.Page, fonts: dict, glyphs: list[dict]) -> list[dict]:
    raw = page.get_text("rawdict")
    lines = []
    for block in raw["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            spans = []
            for span in line["spans"]:
                spans.append(
                    {
                        "font": span["font"],
                        "size": span["size"],
                        "bbox": span["bbox"],
                        "chars": dedupe_chars([dict(c) for c in span["chars"]]),
                    }
                )
            lines.append({"bbox": line["bbox"], "spans": spans, "wmode": line.get("wmode", 0)})
    if not any(line_needs_rebuild(line, fonts) for line in lines) and not glyphs:
        return []
    apply_overlay(lines, glyphs, page.rect.height)
    insert_missing(lines, glyphs, page.rect.height)
    emitted = []
    for line in lines:
        items = []
        for span in line["spans"]:
            base = span["font"].split("+")[-1]
            for char in span["chars"]:
                items.append(
                    {
                        "text": plain(char["c"]),
                        "font": char.get("_font", base),
                        "size": char.get("_size", span["size"]),
                        "x": char["origin"][0],
                        "y": char["origin"][1],
                        "bbox": char["bbox"],
                    }
                )
        if not items:
            continue
        base_size = median([item["size"] for item in items if item["text"].strip()]) or items[0]["size"]
        normal_tops = [item["bbox"][1] for item in items if item["size"] >= base_size - 1 and item["text"].strip()]
        normal_top = median(normal_tops) if normal_tops else items[0]["bbox"][1]
        parts: list[tuple] = []
        script: list[str] = []
        script_kind = ""

        def flush_script():
            nonlocal script, script_kind
            if not script:
                return
            body = "".join(script)
            if script_kind == "super":
                parts.append(("text", "^{" + body + "}"))
            else:
                parts.append(("text", "_{" + body + "}"))
            script = []
            script_kind = ""

        index = 0
        while index < len(items):
            item = items[index]
            info = fonts["base"].get(item["font"])
            collided = info["collided"] if info else set()
            folded = fold_math(expand_ligatures(item["text"]))
            math_letter = len(item["text"]) == 1 and ord(item["text"]) >= 0x1D400
            if math_letter and folded in collided and folded.strip():
                run = [item]
                cursor = index + 1
                while cursor < len(items) and fold_math(items[cursor]["text"]) == folded and items[cursor]["font"] == item["font"]:
                    run.append(items[cursor])
                    cursor += 1
                if len(run) >= 3:
                    flush_script()
                    box = fitz.Rect(run[0]["bbox"])
                    for piece in run[1:]:
                        box |= fitz.Rect(piece["bbox"])
                    parts.append(("crop", box, "".join(fold_math(piece["text"]) for piece in run)))
                    index = cursor
                    continue
            small = item["size"] <= base_size - 2
            kind = ""
            if small and item["text"].strip():
                # 上标的字框顶比同行正文更高；下标贴着基线或更低。
                kind = "super" if item["bbox"][1] < normal_top - 0.4 else "sub"
            if kind:
                if script_kind and script_kind != kind:
                    flush_script()
                script_kind = kind
                script.append(folded)
            else:
                flush_script()
                parts.append(("text", folded))
            index += 1
        flush_script()
        emitted.append({"bbox": fitz.Rect(line["bbox"]), "parts": parts})
    return emitted


def save_clip(page: fitz.Page, rect: fitz.Rect, dest: Path, hairline: bool = False) -> bool:
    rect = (rect + (-1.5, -1.2, 1.5, 1.2)) & page.rect
    if rect.is_empty or rect.width < 8 or rect.height < 6:
        return False
    scale = 2.2
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rect, alpha=False)
    if pix.width > 1800:
        scale *= 1800 / pix.width
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rect, alpha=False)
    samples = pix.samples
    step = pix.n
    dark_rows = set()
    dark = 0
    white = 0
    ink = 0
    seen = 0
    for row in range(pix.height):
        row_dark = False
        start = row * pix.width * step
        for col in range(0, pix.width, 2):
            i = start + col * step
            red, green, blue = samples[i], samples[i + 1], samples[i + 2]
            seen += 1
            if red > 242 and green > 242 and blue > 242:
                white += 1
            elif max(red, green, blue) < 80:
                ink += 1
            if red < 210 or green < 210 or blue < 210:
                dark += 1
                row_dark = True
        if row_dark:
            dark_rows.add(row)
    if dark < 8:
        return False
    if hairline and len(dark_rows) < 8:
        return False
    # 扁图里的色条、流程图和横幅几乎没有白底。公式图以白底黑字为主。
    if hairline and (seen == 0 or white / seen < 0.68 or ink / seen < 0.003):
        return False
    data = pix.tobytes("jpeg", jpg_quality=70)
    if len(data) < 400 or len(data) > MAX_IMAGE_BYTES:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return True


def formula_strips(doc: fitz.Document, page: fitz.Page) -> list[fitz.Rect]:
    area = max(page.rect.width * page.rect.height, 1)
    found = []
    seen = set()
    for info in page.get_image_info(xrefs=True):
        xref = int(info.get("xref") or 0)
        if xref <= 0 or xref in seen:
            continue
        seen.add(xref)
        box = fitz.Rect(info["bbox"])
        if box.height < 8 or box.height >= 48 or box.width < 90:
            continue
        if box.width / max(box.height, 1) < 2.4:
            continue
        if box.width * box.height > area * 0.28:
            continue
        found.append(box)
    found.sort(key=lambda box: (box.y0, box.x0))
    return found


def eq_hits(page: fitz.Page) -> list[dict]:
    hits = []
    for number in range(1, 40):
        clusters = []
        for rect in page.search_for(f"({number})"):
            if rect.width > 36:
                continue
            placed = False
            for cluster in clusters:
                if abs(cluster["y"] - rect.y0) < 2.5 and rect.x0 - cluster["x1"] < 8:
                    cluster["x0"] = min(cluster["x0"], rect.x0)
                    cluster["x1"] = max(cluster["x1"], rect.x1)
                    cluster["y"] = min(cluster["y"], rect.y0)
                    placed = True
                    break
            if not placed:
                clusters.append({"n": number, "y": rect.y0, "x0": rect.x0, "x1": rect.x1})
        for cluster in clusters:
            if cluster["x1"] - cluster["x0"] < 42:
                hits.append(cluster)
    hits.sort(key=lambda hit: (hit["y"], hit["x0"]))
    return hits


EQ_LINE = re.compile(r"^\s*\((\d{1,2})\)\s*$")


def insert_formula_lines(prose: list[str], formulas: list[tuple[str, fitz.Rect]], hits: list[dict]) -> list[str]:
    """把公式图插到同一页里对应的 (n) 行前面。对不上编号就放在正文末尾。"""
    used = set()
    inserts: dict[int, list[str]] = defaultdict(list)
    trailing = []
    for name, box in formulas:
        link = f"![公式]({name})"
        center = (box.y0 + box.y1) / 2
        chosen = None
        best = 10**9
        for index, hit in enumerate(hits):
            if index in used:
                continue
            dist = abs(center - (hit["y"] + 6))
            if dist < best:
                best = dist
                chosen = index
        if chosen is None or best > 28:
            trailing.append(link)
            continue
        used.add(chosen)
        number = str(hits[chosen]["n"])
        # 这一页上第 k 个 (n)
        order = sum(1 for i in range(chosen) if hits[i]["n"] == hits[chosen]["n"])
        seen = 0
        placed = False
        for line_index, line in enumerate(prose):
            match = EQ_LINE.match(line)
            if match and match.group(1) == number:
                if seen == order:
                    inserts[line_index].append(link)
                    placed = True
                    break
                seen += 1
        if not placed:
            trailing.append(link)
    if not inserts and not trailing:
        return prose
    out = []
    for line_index, line in enumerate(prose):
        out.extend(inserts.get(line_index, []))
        out.append(line)
    out.extend(trailing)
    return out


def render_emitted(page: fitz.Page, emitted: list[dict], image_dir: Path, page_no: int) -> str:
    rows = []
    crop_index = 0
    for line in emitted:
        pieces = []
        for kind, payload, *rest in [(part[0], part[1], *part[2:]) for part in line["parts"]]:
            if kind == "text":
                pieces.append(payload)
                continue
            fallback = rest[0] if rest else ""
            crop_index += 1
            name = f"fline-p{page_no}-{crop_index}.jpg"
            if save_clip(page, payload, image_dir / name):
                pieces.append(f" ![公式](images/{name})")
            else:
                pieces.append(fallback)
        text = "".join(pieces).rstrip()
        if any(ch in BAD_CHARS or "\ue000" <= ch <= "\uf8ff" for ch in text):
            box = line["bbox"]
            # 一整段被收成一行时，裁出来会盖住正文。只裁单行符号。
            if box.height <= 36 or box.width <= 160:
                crop_index += 1
                name = f"fline-p{page_no}-{crop_index}.jpg"
                if save_clip(page, box, image_dir / name):
                    rows.append(f"![公式](images/{name})")
                    continue
        if text:
            rows.append(text)
    return "\n".join(rows)


def rebuild_page(doc: fitz.Document, page: fitz.Page, image_dir: Path, page_no: int, old_prose: str) -> str | None:
    fonts = font_db(doc, page)
    if not any(info["special"] or info["collided"] for info in fonts["base"].values()):
        # 仍可能有上下标。有 BAD 字符或字号差才重建。
        raw = page.get_text("rawdict")
        interesting = False
        for block in raw["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                if line_needs_rebuild(line, fonts):
                    interesting = True
                    break
        if not interesting:
            return None
    glyphs = content_glyphs(page, fonts) if any(info["special"] for info in fonts["base"].values()) else []
    emitted = emit_lines(page, fonts, glyphs)
    if not emitted:
        return None
    rebuilt = render_emitted(page, emitted, image_dir, page_no)
    old_compact = re.sub(r"\s+", "", old_prose)
    new_compact = re.sub(r"\s+", "", rebuilt)
    # 去掉重复字形后正文会变短。短太多说明这一页没重建完整，就保持原文。
    if len(new_compact) < max(30, len(old_compact) * 0.45):
        return None
    return rebuilt


def split_front(text: str) -> tuple[str, str]:
    if not text.startswith("---\n"):
        return "", text
    end = text.find("\n---\n", 4)
    if end < 0:
        return "", text
    return text[4:end], text[end + 5 :]


def page_sections(body: str) -> tuple[str, list[tuple[int, str]]]:
    matches = list(re.finditer(r"^## 第 (\d+) 页\s*$", body, re.M))
    if not matches:
        return body, []
    preamble = body[: matches[0].start()]
    sections = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        sections.append((int(match.group(1)), body[match.start() : end]))
    return preamble, sections


def repair_pdf(doc_path: Path, source: Path, dry: bool) -> dict:
    original = doc_path.read_text(encoding="utf-8")
    front, body = split_front(original)
    front_lines = []
    for line in front.splitlines():
        if line.startswith("context:"):
            front_lines.append("context: " + clean_context_line(line.split(":", 1)[1].strip()))
        elif line.startswith("title:"):
            front_lines.append("title: " + re.sub(r"\s+", " ", line.split(":", 1)[1].replace("\ufffd", " ")).strip())
        else:
            front_lines.append(line)
    preamble, sections = page_sections(body)
    preamble = polish_text(preamble).rstrip() + "\n\n"
    # 标题里的替换字符
    preamble = re.sub(r"^# .*$", lambda m: re.sub(r"\s+", " ", m.group(0).replace("\ufffd", " ")).rstrip(), preamble, count=1, flags=re.M)
    stats = {"formulas": 0, "rebuilt": 0}
    if source.suffix.lower() != ".pdf" or not source.exists():
        new_body = expand_ligatures(preamble)
        new_text = "---\n" + "\n".join(front_lines) + "\n---\n" + new_body
        if new_text != original and not dry:
            doc_path.write_text(new_text, encoding="utf-8")
        return stats
    image_dir = doc_path.parent / "images"
    pdf = fitz.open(source)
    chunks = [expand_ligatures(preamble)]
    try:
        for page_no, section in sections:
            if page_no < 1 or page_no > pdf.page_count:
                chunks.append(expand_ligatures(section))
                continue
            page = pdf[page_no - 1]
            lines = section.splitlines()
            header = lines[0] if lines else f"## 第 {page_no} 页"
            rest = lines[1:]
            figures = [line for line in rest if line.strip().startswith("![")]
            figures = [line for line in figures if "formula-p" not in line and "fline-p" not in line]
            prose_lines = [line for line in rest if line.strip() and not line.strip().startswith("![")]
            old_prose = "\n".join(prose_lines)
            text_layer = page.get_text("text").strip()
            rebuilt = None
            if len(text_layer) >= 80:
                rebuilt = rebuild_page(pdf, page, image_dir, page_no, old_prose)
            strips = formula_strips(pdf, page)
            if rebuilt is None and not strips:
                chunks.append(expand_ligatures(section))
                continue
            if rebuilt:
                stats["rebuilt"] += 1
                prose = [line for line in rebuilt.splitlines() if line.strip()]
            else:
                prose = [expand_ligatures(line) for line in prose_lines]
            links = []
            for index, box in enumerate(strips, 1):
                name = f"formula-p{page_no}-{index}.jpg"
                if dry or save_clip(page, box, image_dir / name, hairline=True):
                    links.append((f"images/{name}", box))
            if links:
                stats["formulas"] += len(links)
                prose = insert_formula_lines(prose, links, eq_hits(page))
            block = [header, ""]
            block.extend(prose)
            block.append("")
            block.extend(figures)
            block.append("")
            chunks.append("\n".join(block).rstrip() + "\n\n")
    finally:
        pdf.close()
    new_text = "---\n" + "\n".join(front_lines) + "\n---\n" + "".join(chunks)
    new_text = plain(re.sub(r"\n{4,}", "\n\n\n", new_text))
    if new_text != original and not dry:
        doc_path.write_text(new_text, encoding="utf-8")
    stats["changed"] = new_text != original
    return stats


def source_of(text: str) -> Path | None:
    match = re.search(r"^source:\s*(\S+)\s*$", text, re.M)
    if not match:
        return None
    path = ROOT / match.group(1)
    return path if path.exists() else None


def main() -> int:
    dry = "--dry" in sys.argv
    only = ""
    start = ""
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    if "--from" in sys.argv:
        start = sys.argv[sys.argv.index("--from") + 1]
    docs = sorted(READABLE.glob("*/doc.md"))
    if only:
        docs = [path for path in docs if only in str(path)]
    if start:
        docs = [path for path in docs if path.parent.name >= start]
    if "--polish" in sys.argv:
        polished = 0
        for path in docs:
            text = path.read_text(encoding="utf-8")
            new = polish_text(text)
            if new != text:
                if not dry:
                    path.write_text(new, encoding="utf-8")
                polished += 1
        print(f"polished {polished} of {len(docs)}")
        return 0
    changed = rebuilt = formulas = 0
    for path in docs:
        text = path.read_text(encoding="utf-8", errors="replace")
        source = source_of(text)
        if source is None:
            front, body = split_front(text)
            # 没有源文件也清上下文
            new_front = "\n".join(
                "context: " + clean_context_line(line.split(":", 1)[1].strip()) if line.startswith("context:") else line
                for line in front.splitlines()
            )
            new_body = clean_context_line(body) if "邻近原文" in body[:500] else body
            new_text = "---\n" + new_front + "\n---\n" + expand_ligatures(new_body) if front else expand_ligatures(text)
            if new_text != text and not dry:
                path.write_text(new_text, encoding="utf-8")
                changed += 1
            continue
        try:
            stats = repair_pdf(path, source, dry)
        except Exception as exc:
            print(f"fail {path.parent.name}: {exc}", flush=True)
            continue
        changed += int(stats.get("changed", False))
        rebuilt += stats["rebuilt"]
        formulas += stats["formulas"]
        if (changed + rebuilt) % 25 == 0:
            print(f".. {path.parent.name} changed {changed} rebuilt {rebuilt} formulas {formulas}", flush=True)
        if dry and stats.get("changed"):
            print(path.parent.name, "rebuilt", stats["rebuilt"], "formulas", stats["formulas"])
    print(f"docs {len(docs)} changed {changed} rebuilt_pages {rebuilt} formula_images {formulas} dry {dry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
