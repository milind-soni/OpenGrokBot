"""Verify a language's applied state on the installed UI (idempotency + residual check).

Usage:  python tools/verify_lang.py <lang-code> [--app <dir>]
"""
import argparse
import bisect
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")

from hanhua import apply_translations, find_app_dir, find_ui_files, scan_literals, is_block

parser = argparse.ArgumentParser()
parser.add_argument("lang")
parser.add_argument("--app", default=None)
args = parser.parse_args()

app_dir = args.app or find_app_dir()
if not app_dir:
    sys.exit("No OpenMausBot install found. Use --app <dir>.")
ui_files = find_ui_files(app_dir)
html_path = next((f for f in ui_files if f.endswith("index.html")), None)
js_path = next((f for f in ui_files if f.endswith(".js")), None)
if not html_path or not js_path:
    sys.exit("Could not locate index.html / bundle in " + app_dir)

html = open(html_path, encoding="utf-8").read()
m = re.search(r'<html[^>]*lang="([^"]*)"', html)
cur = m.group(1) if m else None
content = open(js_path, encoding="utf-8").read()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
trans = json.load(open(os.path.join(ROOT, "locales", args.lang + ".json"), encoding="utf-8"))
trans = {k: v for k, v in trans.items() if not k.startswith("_")}
new, count = apply_translations(content, trans)
changed = new != content

ranges = scan_literals(content)
starts = [r[0] for r in ranges]
keys = sorted(trans.keys(), key=len, reverse=True)
residual = {}


def collect():
    candidates = []
    for k in keys:
        v = trans[k]
        if v == k:
            continue
        pat = re.compile(re.escape(k))
        k_start_space = k.startswith(" ")
        k_end_space = k.endswith(" ")
        for mm in pat.finditer(content):
            s, e = mm.span()
            if not k_start_space and s > 0:
                c = content[s - 1]
                if is_block(c, content[s] if s < len(content) else ""):
                    continue
            if not k_end_space and e < len(content):
                c = content[e]
                if is_block(c, content[e + 1] if e + 1 < len(content) else ""):
                    continue
            idx = bisect.bisect_right(starts, s) - 1
            if idx < 0 or s >= ranges[idx][1]:
                continue
            candidates.append((s, e, k))
    candidates.sort(key=lambda t: (t[0], -t[1]))
    last_end = -1
    for s, e, k in candidates:
        if s < last_end:
            continue
        residual[k] = residual.get(k, 0) + 1
        last_end = e


collect()


def charclass(c):
    o = ord(c)
    if 0x4E00 <= o <= 0x9FFF:
        return "CJK"
    if 0x3040 <= o <= 0x309F:
        return "hiragana"
    if 0x30A0 <= o <= 0x30FF:
        return "katakana"
    if 0xAC00 <= o <= 0xD7AF:
        return "hangul"
    if 0x0400 <= o <= 0x04FF:
        return "cyrillic"
    return None


lang_of = {"zh-CN": "CJK", "zh-TW": "CJK", "ja-JP": "hiragana+katakana+CJK",
           "ko-KR": "hangul", "ru-RU": "cyrillic", "de-DE": "latin",
           "es-ES": "latin", "fr-FR": "latin"}

expect = set(lang_of.get(args.lang, "").split("+"))
foreign = {}
for ch in set(content):
    cls = charclass(ch)
    if cls and cls not in expect:
        foreign[cls] = foreign.get(cls, 0) + 1

print("LANG_ATTR:", cur, "EXPECT:", args.lang, "MATCH:", cur == args.lang)
print("REAPPLY_COUNT:", count, "CONTENT_CHANGED:", changed)
print("REAL_RESIDUAL_KEYS:", sum(residual.values()), "UNIQUE:", len(residual))
for k, n in sorted(residual.items(), key=lambda x: -x[1])[:10]:
    print("   ", repr(k)[:80], "x", n)
if foreign:
    print("FOREIGN_SCRIPTS:", foreign)
else:
    print("FOREIGN_SCRIPTS: none")
ok = (cur == args.lang and not residual and not foreign)
print("VERDICT:", "OK" if ok else "ISSUES")