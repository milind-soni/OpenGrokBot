#!/usr/bin/env python3
"""OpenMausBot Localization - multilingual UI patcher.

Replaces UI strings inside the installed OpenMausBot app with your chosen
language. All languages live in the locales/ directory; add a new *.json file
to support a new language - nothing is hardcoded.
"""

import argparse
import bisect
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP_DIRS = [
    os.environ.get("LOCALAPPDATA", "") + r"\Programs\openmausbot",
    os.environ.get("PROGRAMFILES", "") + r"\openmausbot",
    "/Applications/OpenMausBot.app",
    os.path.expanduser("~/.local/share/openmausbot"),
    "/opt/openmausbot",
    "/usr/lib/openmausbot",
]

# --- console cosmetics -------------------------------------------------------
try:
    if os.name == "nt":
        import ctypes

        ctypes.windll.kernel32.SetConsoleMode(ctypes.windll.kernel32.GetStdHandle(-11), 7)
    COLOR = sys.stdout.isatty()
except Exception:
    COLOR = False


def paint(code, s):
    return "\033[{}m{}\033[0m".format(code, s) if COLOR else s


def c_bold(s): return paint("1", s)
def c_dim(s): return paint("2", s)
def c_ok(s): return paint("32", s)
def c_err(s): return paint("31", s)
def c_warn(s): return paint("33", s)
def c_cyan(s): return paint("36", s)
def c_mag(s): return paint("35", s)
def c_yellow(s): return paint("33", s)
def c_title(s): return paint("1;44", s)
def c_head(s): return paint("1;36", s)


def wlen(s):
    """Display width of a string (East Asian wide chars and most emoji = 2)."""
    s = re.sub(r"\x1b\[[0-9;]*m", "", s)
    w = 0
    for ch in s:
        if unicodedata.east_asian_width(ch) in ("W", "F"):
            w += 2
        else:
            w += 1
    return w


def box(title, lines, width=60):
    top = "┌" + "─" * (width - 2) + "┐"
    out = [top]
    for line in lines:
        text = str(line)
        pad = max(0, width - 3 - wlen(text))
        out.append("│ " + text + " " * pad + "│")
    out.append("└" + "─" * (width - 2) + "┘")
    return "\n".join(out)


def step(n, total, msg, ok=True):
    mark = c_ok("✓") if ok else c_err("✗")
    return "  {} [{}/{}] {}".format(mark, n, total, msg)


# --- locale discovery ---------------------------------------------------------
def base_dir():
    return os.path.dirname(os.path.abspath(__file__))


def locales_dir():
    return os.path.join(base_dir(), "locales")


def discover_locales():
    """Scan locales/*.json and read _meta - the source of truth for languages."""
    d = locales_dir()
    if not os.path.isdir(d):
        return []
    result = []
    for name in sorted(os.listdir(d)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(d, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(data, dict):
            continue
        meta = data.get("_meta", {})
        code = meta.get("code") or name[:-5]
        result.append({
            "code": code,
            "flag": meta.get("flag", ""),
            "name": meta.get("name", code),
            "name_en": meta.get("name_en", code),
            "note": meta.get("note", ""),
            "path": path,
        })
    return result


def load_locale(code):
    for loc in discover_locales():
        if loc["code"].lower() == code.lower():
            with open(loc["path"], "r", encoding="utf-8") as f:
                data = json.load(f)
            trans = {k: v for k, v in data.items() if not k.startswith("_")}
            return loc, trans
    return None, None


def render_menu(locales, width=66):
    lines = [c_title("  🌐  OpenMausBot Localization")]
    lines.append("")
    lines.append(c_dim("Pick a language / 选择语言 / 言語を選択 / 언어를 선택 / Elige un idioma / Wähle eine Sprache / Выберите язык:"))
    lines.append("")
    col = max(len(str(len(locales))), 2) + 2
    name_w = max(wlen(l["name"]) for l in locales) + 2
    for i, loc in enumerate(locales, 1):
        num = " " * (col - len(str(i))) + str(i)
        flag = loc["flag"] + "  " if loc["flag"] else "   "
        name = loc["name"] + " " * max(0, name_w - wlen(loc["name"]))
        line = "  {} {} {} {}".format(c_cyan(num), flag, c_bold(name), c_dim("(" + loc["code"] + ")"))
        if loc["note"]:
            line += "  " + c_dim("· " + loc["note"])
        lines.append(line)
    return box("", lines, width)


def select_locale(interactive):
    """Interactive language picker; skipped when --lang is given."""
    locales = discover_locales()
    if not locales:
        print(c_err("✗ No language files found in locales/."))
        print("  Add a *.json file (copy zh-CN.json and translate the values).")
        return None, None
    if not interactive:
        return locales[0], load_locale(locales[0]["code"])[1]
    print()
    print(render_menu(locales))
    print()
    while True:
        try:
            prompt = "  Enter a number (1-{}): ".format(len(locales))
            choice = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            print(c_warn("Cancelled."))
            return None, None
        if choice.isdigit() and 1 <= int(choice) <= len(locales):
            loc = locales[int(choice) - 1]
            return loc, load_locale(loc["code"])[1]
        print("  " + c_err("Invalid choice. Please enter 1-{}.".format(len(locales))))


# --- app discovery -------------------------------------------------------------
def is_app_dir(d):
    """True if d looks like an OpenMausBot install (either layout)."""
    return (
        os.path.isfile(os.path.join(d, "resources", "app.asar"))
        or os.path.isfile(os.path.join(d, "Contents", "Resources", "app.asar"))
    )


def resource_base(app_dir):
    """Return the directory that holds app.asar + ui/.

    Windows layout: <app>/resources/{app.asar,ui}
    macOS .app layout: <app>.app/Contents/Resources/{app.asar,ui}
    """
    for base in (app_dir, os.path.join(app_dir, "Contents", "Resources")):
        if os.path.isfile(os.path.join(base, "app.asar")) and os.path.isdir(os.path.join(base, "ui")):
            return base
        rb = os.path.join(base, "resources")
        if os.path.isfile(os.path.join(rb, "app.asar")) and os.path.isdir(os.path.join(rb, "ui")):
            return rb
    return app_dir


def find_app_dir():
    for d in APP_DIRS:
        if d and is_app_dir(d):
            return d
    roots = [
        os.environ.get("LOCALAPPDATA", ""),
        os.environ.get("PROGRAMFILES", ""),
        os.path.expanduser("~"),
        "/Applications",
    ]
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        try:
            entries = os.listdir(root)
        except OSError:
            continue
        for entry in sorted(entries):
            cand = os.path.join(root, entry)
            if entry.lower().startswith("openmaus") and is_app_dir(cand):
                return cand
    return None


def read_asar_package_json(app_dir):
    asar_path = os.path.join(resource_base(app_dir), "app.asar")
    if not os.path.isfile(asar_path):
        return None
    with open(asar_path, "rb") as f:
        f.seek(8)
        f.read(4)
        str_size = struct.unpack("<I", f.read(4))[0]
        header = json.loads(f.read(str_size).decode("utf-8"))
        base = 16 + ((str_size + 3) // 4) * 4
    found = []

    def walk(node, path=""):
        for name, info in node.get("files", {}).items():
            p = path + "/" + name
            if "files" in info:
                walk(info, p)
            elif p.endswith("package.json"):
                found.append((p, info))

    walk(header)
    if not found:
        return None
    p, info = found[0]
    with open(asar_path, "rb") as f:
        f.seek(base + int(info["offset"]))
        data = f.read(info["size"])
    try:
        return json.loads(data.decode("utf-8"))
    except json.JSONDecodeError:
        return None


def detect_version(app_dir):
    pkg = read_asar_package_json(app_dir)
    if pkg and pkg.get("version"):
        return str(pkg["version"])
    return "unknown"


def find_ui_files(app_dir):
    ui_dir = os.path.join(resource_base(app_dir), "ui")
    if not os.path.isdir(ui_dir):
        return []
    files = []
    html = os.path.join(ui_dir, "index.html")
    if os.path.isfile(html):
        files.append(html)
        with open(html, "r", encoding="utf-8") as f:
            content = f.read()
        m = re.search(r'<script[^>]+type="module"[^>]+src="([^"]+\.js)"', content)
        if m:
            src = m.group(1)
            base = src.split("?")[0].split("/")[-1]
            candidate = os.path.join(ui_dir, "assets", base)
            if os.path.isfile(candidate):
                files.append(candidate)
    return files


# --- translation engine ---------------------------------------------------------
def scan_literals(content):
    """Locate string-literal ranges. A quote directly preceded by an identifier
    character (alnum/_/$) cannot OPEN a literal - it is the tail of one already
    scanned. This stops adjacent quotes (e.g. JSX `"a":"b"` / `...",children:l.jsx("...`)
    from being mis-paired, which previously dropped whole literals from the scan
    and left some UI strings untranslated."""
    ranges = []
    i = 0
    n = len(content)
    while i < n:
        ch = content[i]
        if ch in "\"'`":
            if ch in "\"'" and i > 0 and (content[i - 1].isalnum() or content[i - 1] in "_$"):
                i += 1
                continue
            j = i + 1
            while j < n:
                c = content[j]
                if c == "\\":
                    j += 2
                    continue
                if c == ch:
                    break
                j += 1
            if j < n:
                ranges.append((i, j + 1, ch))
                i = j + 1
                continue
        i += 1
    return ranges


def escape_for(value, quote):
    value = value.replace("\\", "\\\\")
    if quote == '"':
        return value.replace('"', '\\"')
    if quote == "'":
        return value.replace("'", "\\'")
    return value.replace("`", "\\`").replace("${", "\\${")


# Characters that can only appear in code, never in plain UI text.
# Adjacency to one of these means the match is part of a statement/expression
# (e.g. `On=!1`, `fn(On)`, `On?x:y`) and must NOT be translated.
# Note: `,` is intentionally NOT here - it is ordinary prose punctuation
# ("on this computer, so only pair..."). `$` is special-cased below: it only
# blocks when it starts an identifier (`$foo`), not template interpolation (`${`).
OPERATORS = set("=!?:;()[]{}<>+-*/%&|^~\\")


def is_block(c, nxt):
    """True when `c` makes a match boundary a code token instead of prose."""
    if c.isalnum() or c == "_":
        return True
    if c == "$":
        return nxt != "{"
    return c in OPERATORS


def apply_translations(content, trans):
    """Replace UI strings. Instead of one alternation regex (which, when the
    longest key is rejected by the boundary/literal checks, consumes the region
    so a shorter key that is a substring of it can never match), we scan each
    key independently, collect every acceptable match, and let the longest key
    win at any position. This fixes translations such as 'Companion' inside a
    longer rejected sentence."""
    if not trans:
        return content, 0
    ranges = scan_literals(content)
    starts = [r[0] for r in ranges]
    keys = sorted(trans.keys(), key=len, reverse=True)
    candidates = []  # (start, end, key, value)
    for k in keys:
        v = trans[k]
        if v == k:
            continue  # identity translation - nothing would change
        pat = re.compile(re.escape(k))
        k_start_space = k.startswith(" ")
        k_end_space = k.endswith(" ")
        for m in pat.finditer(content):
            s, e = m.span()
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
            candidates.append((s, e, k, v))

    # longest-first greedy on start position: a longer key keeps its span and
    # blocks shorter keys that would overlap it.
    candidates.sort(key=lambda t: (t[0], -t[1]))
    chosen = []
    last_end = -1
    for s, e, k, v in candidates:
        if s < last_end:
            continue
        chosen.append((s, e, k, v))
        last_end = e

    if not chosen:
        return content, 0
    # apply from the end so earlier offsets stay valid
    def quote_for(s):
        idx = bisect.bisect_right(starts, s) - 1
        return ranges[idx][2]
    for s, e, k, v in reversed(chosen):
        quote = quote_for(s)
        content = content[:s] + escape_for(v, quote) + content[e:]
    return content, len(chosen)


def patch_html(content, lang_code):
    return re.sub(r'<html[^>]*lang="[^"]*"', '<html lang="{}"'.format(lang_code), content)


def current_lang(app_dir):
    """Read the <html lang="..."> attribute from index.html (or None if unknown)."""
    html = os.path.join(resource_base(app_dir), "ui", "index.html")
    if not os.path.isfile(html):
        return None
    try:
        with open(html, "r", encoding="utf-8") as f:
            content = f.read()
    except (UnicodeDecodeError, OSError):
        return None
    m = re.search(r'<html[^>]*lang="([^"]*)"', content)
    return m.group(1) if m else None


# --- backup / restore ------------------------------------------------------------
def backup_files(files, app_dir, version, backup_root, dry_run):
    if not files:
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(backup_root, "{}-{}".format(version, stamp))
    manifest = {"app_dir": app_dir, "version": version, "files": {}}
    if not dry_run:
        os.makedirs(dest, exist_ok=True)
    for path in files:
        rel = os.path.relpath(path, app_dir)
        manifest["files"][rel] = None
        if dry_run:
            continue
        target = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(path, target)
        manifest["files"][rel] = os.path.basename(path)
    if not dry_run:
        with open(os.path.join(dest, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
    return dest


def all_backups(backup_root):
    if not os.path.isdir(backup_root):
        return []
    return sorted(d for d in os.listdir(backup_root) if os.path.isdir(os.path.join(backup_root, d)))


def latest_backup(backup_root):
    backups = all_backups(backup_root)
    if not backups:
        return None
    return os.path.join(backup_root, backups[-1])


def restore(backup_root, app_dir, backup_name=None):
    backups = all_backups(backup_root)
    if not backups:
        print(c_err("✗ No backup found in {}.").format(backup_root))
        return 1
    if backup_name:
        backup = os.path.join(backup_root, backup_name)
        if not os.path.isdir(backup):
            print(c_err("✗ Unknown backup: {}").format(backup_name))
            print("  Available: " + ", ".join(backups))
            return 1
    else:
        # Default: the earliest backup is the untouched original (English).
        backup = os.path.join(backup_root, backups[0])
    manifest_path = os.path.join(backup, "manifest.json")
    if os.path.isfile(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        app_dir = manifest.get("app_dir", app_dir)
    if not app_dir or not os.path.isdir(app_dir):
        print(c_err("✗ Cannot determine the app directory for this backup."))
        return 1
    count = 0
    for root, _, names in os.walk(backup):
        for name in names:
            if name == "manifest.json":
                continue
            src = os.path.join(root, name)
            rel = os.path.relpath(root, backup)
            if rel == ".":
                rel = ""
            dest = os.path.join(app_dir, rel, name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(src, dest)
            count += 1
    print("  " + c_ok("Restored {} file(s) from: {}").format(count, backup))
    if not backup_name:
        print("  This was the original untouched backup - the UI is back to English.")
    print("  Restart OpenMausBot to see the original interface.")
    return 0


# --- syntax self-check (optional) -------------------------------------------------
def node_available():
    try:
        r = subprocess.run(["node", "--version"], capture_output=True, text=True)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def syntax_check(code, label):
    """Validate JS with `node --check` when available. Returns (bool, message)."""
    if not node_available():
        return None, "node.js not found - skipped syntax check"
    fd, path = tempfile.mkstemp(suffix=".js", prefix="omb_check_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(code)
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if r.returncode == 0:
        return True, "syntax OK"
    return False, "syntax ERROR: " + (r.stderr.strip().splitlines() or ["?"])[0]


# --- main --------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        prog="hanhua.py",
        description="OpenMausBot Localization - multilingual UI patcher (auto-detect, backup, translate).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  hanhua.py                  interactive language picker\n"
            "  hanhua.py --lang zh-TW     translate with a specific language\n"
            "  hanhua.py --list           list available languages\n"
            "  hanhua.py --path D:/apps   point at a specific install dir\n"
            "  hanhua.py --dry-run        preview only - write nothing\n"
            "  hanhua.py --dry-run --check   preview + validate JS syntax (needs node.js)\n"
            "  hanhua.py --restore        restore the ORIGINAL English UI (earliest backup)\n"
            "  hanhua.py --restore --backup <name>   restore a specific backup\n"
        ),
    )
    parser.add_argument("--path", help="OpenMausBot install directory")
    parser.add_argument("--lang", default=None, help="language code, e.g. zh-CN / zh-TW / ja-JP / ko-KR / es-ES / fr-FR / de-DE / ru-RU")
    parser.add_argument("--list", action="store_true", help="list all available languages")
    parser.add_argument("--dry-run", action="store_true", help="only report what would change - write nothing")
    parser.add_argument("--check", action="store_true", help="also validate the resulting JS with node --check (dry-run only)")
    parser.add_argument("--restore", action="store_true", help="restore the original English UI (earliest backup)")
    parser.add_argument("--backup", default=None, help="backup name to restore from (with --restore)")
    parser.add_argument("--no-backup", action="store_true", help="do not create a backup before translating")
    parser.add_argument("--no-auto-restore", action="store_true", help="do NOT auto-restore English before translating (may leave a mixed-language UI)")
    args = parser.parse_args()

    # banner
    print(c_head("  OpenMausBot Localization"))
    print(c_dim("  " + "=" * 46))

    if args.list:
        locales = discover_locales()
        if not locales:
            print(c_err("  ✗ No language files found in locales/."))
            return 1
        print(render_menu(locales))
        return 0

    if args.restore:
        print()
        rc = restore(os.path.join(base_dir(), "backups"), args.path or "", args.backup)
        return rc

    # resolve language
    if args.lang:
        loc, trans = load_locale(args.lang)
        if not loc:
            print(c_err("  ✗ Unknown language code: {}").format(args.lang))
            print("  Available: " + ", ".join(l["code"] for l in discover_locales()))
            return 1
        interactive = False
    else:
        loc, trans = select_locale(True)
        if not loc:
            return 1
        interactive = True
    lang_code, lang_name, lang_en = loc["code"], loc["name"], loc["name_en"]
    print("  {} {} ({}) - {} entries".format(c_ok("●"), lang_name, lang_code, len(trans)))

    # locate app
    app_dir = args.path or find_app_dir()
    if not app_dir or not os.path.isdir(app_dir):
        print(c_err("  ✗ OpenMausBot not found."))
        print("    Pass --path with the install directory, e.g. --path \"D:\\Programs\\openmausbot\".")
        return 1
    app_dir = os.path.abspath(app_dir)
    app_dir = resource_base(app_dir)  # resolve macOS .app -> Contents/Resources
    print(step(1, 4, "Locating OpenMausBot: {}".format(c_bold(app_dir))))

    version = detect_version(app_dir)
    print(step(2, 4, "Detected version: {}".format(c_bold("v" + version))))

    files = find_ui_files(app_dir)
    if not files:
        print(step(3, 4, "Found UI files", ok=False))
        print(c_err("  ✗ No UI resources found under resources/ui/."))
        return 1
    print(step(3, 4, "Found {} UI file(s)".format(len(files))))

    # auto-restore to pristine English before applying a language, so the UI is
    # never left as a mix of two languages. Off with --no-auto-restore.
    backup_root = os.path.join(base_dir(), "backups")
    cur_lang = current_lang(app_dir)
    if cur_lang and cur_lang.lower() != "en" and cur_lang.lower() != lang_code.lower():
        if args.dry_run:
            print()
            print(c_warn("  ⚠ UI is currently in '{}' - a real run would first restore".format(cur_lang)))
            print(c_warn("    the original English, then apply '{}'  (dry-run, nothing written)".format(lang_code)))
        elif args.no_auto_restore:
            print()
            print(c_warn("  ⚠ UI is currently in '{}' and --no-auto-restore is set.".format(cur_lang)))
            print(c_warn("    Only remaining English will be replaced - '{}' will stay as-is.".format(cur_lang)))
        else:
            print()
            print(c_warn("  ⚠ UI is currently in '{}' - auto-restoring original English first,".format(cur_lang)))
            print(c_warn("    then applying '{}'  (to guarantee a single-language UI).".format(lang_code)))
            rc = restore(backup_root, app_dir)
            if rc != 0:
                print(c_warn("    Auto-restore failed - continuing anyway (UI may mix languages)."))

    # backup
    backup_dir = None
    if not args.no_backup:
        backup_dir = backup_files(files, app_dir, version, backup_root, args.dry_run)
        if backup_dir:
            print(step(4, 4, "Backup: {}".format(c_dim(backup_dir))))
        else:
            print(step(4, 4, "Backup skipped (dry-run)"))
    else:
        print(step(4, 4, "Backup skipped (--no-backup)"))

    # apply
    total = 0
    detail = []
    all_ok = True
    for path in sorted(files):
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        if path.endswith(".html"):
            new_content = patch_html(content, lang_code)
            changed = new_content != content
            if not args.dry_run and changed:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(new_content)
            detail.append("{}: lang -> {}{}".format(os.path.basename(path), lang_code, " (dry-run)" if args.dry_run else ""))
            continue
        try:
            new_content, count = apply_translations(content, trans)
        except (UnicodeDecodeError, ValueError):
            continue
        total += count
        if args.check and args.dry_run:
            ok, msg = syntax_check(new_content, os.path.basename(path))
            if ok is False:
                all_ok = False
            detail.append("{}: {} replacement(s){} - {}".format(
                os.path.basename(path), count,
                " (dry-run)" if args.dry_run else "",
                c_ok(msg) if ok is not False else c_err(msg)))
        elif count:
            detail.append("{}: {} replacement(s){}".format(os.path.basename(path), count, " (dry-run)" if args.dry_run else ""))
        if not args.dry_run and count:
            try:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(new_content)
            except PermissionError:
                print(c_err("  ✗ Cannot write {} - quit OpenMausBot and try again.".format(path)))
                return 1

    print()
    lines = [
        c_ok("  ✔ Done! {} replacement(s).").format(total),
        "",
    ]
    for d in detail:
        lines.append("    " + d)
    if args.dry_run:
        lines.append("")
        lines.append(c_warn("  Dry-run - nothing was written."))
    else:
        lines.append("")
        lines.append("  Restart OpenMausBot to see the {} interface.".format(lang_name))
        lines.append("  To restore: run  hanhua.py --restore")
    print(box("", lines, 66))
    if args.check and args.dry_run:
        print("  Syntax check: " + (c_ok("PASS") if all_ok else c_err("FAIL")))
        return 0 if all_ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())