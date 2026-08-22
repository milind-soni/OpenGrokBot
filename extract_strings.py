#!/usr/bin/env python3
"""Extract candidate UI strings from the OpenMausBot web UI bundle."""
import json
import os
import re
import sys

def find_bundle():
    """Locate the UI JS bundle without hardcoded personal paths."""
    candidates = []
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    backups = os.path.join(root, "backups")
    if os.path.isdir(backups):
        for d in sorted(os.listdir(backups)):
            base = os.path.join(backups, d)
            for sub in ("resources/ui/assets", "ui/assets"):
                p = os.path.join(base, sub)
                if os.path.isdir(p):
                    for f in sorted(os.listdir(p)):
                        if f.endswith(".js"):
                            candidates.append(os.path.join(p, f))
    install = os.environ.get("LOCALAPPDATA", "")
    for root2 in (
        os.path.join(install, "Programs", "openmausbot"),
        os.path.join(install, "openmausbot"),
    ):
        p = os.path.join(root2, "resources", "ui", "assets")
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                if f.endswith(".js"):
                    candidates.append(os.path.join(p, f))
    return candidates[0] if candidates else None

STRING_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')
TEMPLATE_RE = re.compile(r"`((?:[^`\\]|\\.)*)`")


def split_template(text: str):
    """Split a template-literal body into literal text segments (drops ${...} code parts)."""
    segments = []
    parts = text.split("${")
    segments.append(parts[0])
    for p in parts[1:]:
        depth = 1
        j = 0
        while j < len(p) and depth:
            if p[j] == "{":
                depth += 1
            elif p[j] == "}":
                depth -= 1
            j += 1
        segments.append(p[j:])
    return segments

# Characters allowed in a human-readable UI string
ALLOWED = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    " .,!?;:'\"()[]-+&/%#@<>$=*_~|^`\\\n\t"
)

# Substrings that strongly indicate this is library/code, not UI text
CODE_MARKERS = (
    "function", "=>", "return", "throw new", "typeof", "Object.",
    "constructor", "prototype", ".length", ".join(", ".split(",
    "children:", "jsx", "jsxs", ".map(", ".filter(", "const ", "let ",
    "undefined", "null", "true", "false", "Error(", "error", "Error",
    ".push(", "arguments", "console.", ".test(", ".exec(", ".match(",
    "Promise", "callback", "React", ".props", ".state", ".current",
    ".indexOf(", ".replace(", "charAt", "new RegExp", "URL(", "http",
    "https", "www.", ".com", ".org", "window.", "document.",
    "addEventListener", "navigator.", "localStorage", "import(",
    "export ", "module.", "webkit", "moz", "ms-", "MIME", "Content-Type",
    "application/json", "text/html", "text/plain", "charset=",
    "Access-Control", "Origin", "Referer", "User-Agent", "Accept",
    "Content-Length", "async ", "await ", "querySelector", "getElementById",
    "innerHTML", "createElement", "setTimeout", "setInterval", "requestAnimationFrame",
    "uuid", "UUID", "sha", "md5", "base64", "utf-8", "UTF-8", "ISO-8859",
)

# Regex for a single Tailwind-ish utility token
TAILWIND_TOKEN = re.compile(
    r"^(?:text|bg|border|rounded|flex|grid|mt|mb|ml|mr|mx|my|px|py|pt|pb|pl|pr|p|gap|w|h|min|max|"
    r"justify|items|font|shrink|overflow|cursor|disabled|size|truncate|animate|tabular|absolute|"
    r"relative|uppercase|tracking|leading|space|divide|z|top|left|right|bottom|inline|block|hidden|"
    r"pointer|select|resize|whitespace|break|outline|ring|shadow|opacity|transition|ease|duration|"
    r"delay|col|row|self|content|object|aspect|basis|grow|order|inset|overscroll|antialiased|not|"
    r"first|last|odd|even|visited|focus|active|group|peer|direction|rotate|scale|skew|filter|backdrop)-"
)


def is_tailwind(s: str) -> bool:
    if not s or " " not in s:
        return False
    tokens = s.split()
    if len(tokens) < 2:
        return False
    return all(TAILWIND_TOKEN.match(t) for t in tokens)


def is_ui_candidate(s: str) -> bool:
    if not s:
        return False
    # Must have at least one letter
    if not re.search(r"[A-Za-z]", s):
        return False
    # No unicode escapes or weird escapes
    if "\\u" in s or "\\x" in s:
        return False
    # Strip escapes for analysis
    plain = s.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"').replace("\\\\", "\\")
    # Tailwind class strings
    if is_tailwind(plain):
        return False
    # Single tailwind-ish token or pure class strings
    if plain and not re.search(r"\s", plain) and TAILWIND_TOKEN.match(plain):
        return False
    # Code fragments: contains unbalanced code-y punctuation
    if "&&" in plain or "||" in plain or ",{" in plain or "){" in plain or "=>" in plain:
        return False
    if plain.startswith("),") or plain.startswith(";") or plain.startswith(":{") or plain.startswith("?`"):
        return False
    # HTTP verbs / methods
    if plain in ("POST", "GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
        return False
    # Every char must be printable / allowed
    for ch in plain:
        if ch not in ALLOWED and ord(ch) > 126:
            return False
        if ch in "\r\b\f\v\x00":
            return False
    if len(plain) > 90:
        return False
    # Exclude code markers
    lower = plain.lower()
    for marker in CODE_MARKERS:
        if marker.lower() in lower:
            return False
    # Exclude things that are clearly identifiers (no spaces, mostly lowercase, no caps pattern)
    if not re.search(r"\s", plain) and len(plain) <= 24 and not re.match(r"^[A-Z][a-z]+$", plain):
        # single-word without spaces - only keep capitalized UI-ish words or known UI words
        if not re.match(r"^[A-Z][a-zA-Z]+$", plain):
            return False
    # Exclude strings that are pure ASCII-art-ish or operator sequences
    if re.fullmatch(r"[\W_]+", plain):
        return False
    # Require at least one vowel or common letter run
    if not re.search(r"[aeiouAEIOU]", plain):
        # allow words like "Sync", "Sms" ... keep if starts uppercase
        if not re.match(r"^[A-Z][a-z]+$", plain):
            return False
    return True


def main() -> None:
    bundle = sys.argv[1] if len(sys.argv) > 1 else find_bundle()
    if not bundle:
        print("UI bundle not found - pass its path as the first argument.", file=sys.stderr)
        sys.exit(1)
    out = sys.argv[2] if len(sys.argv) > 2 else "candidates.json"
    with open(bundle, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    counts = {}
    for m in STRING_RE.finditer(content):
        s = m.group(1)
        if not is_ui_candidate(s):
            continue
        counts[s] = counts.get(s, 0) + 1

    for m in TEMPLATE_RE.finditer(content):
        for seg in split_template(m.group(1)):
            seg = seg.strip("`")
            if not is_ui_candidate(seg):
                continue
            counts[seg] = counts.get(seg, 0) + 1

    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    with open(out, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    print(f"wrote {len(items)} candidates to {out}")


if __name__ == "__main__":
    main()