import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOCALES_DIR = os.path.join(ROOT, "locales")


def find_bundle():
    """Locate the UI JS bundle: pristine backup first, then the install dir."""
    candidates = []
    backups = os.path.join(ROOT, "backups")
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

DANGEROUS = re.compile(
    r"(?i)toLowerCase|toUpperCase|localeCompare|\.case|startsWith|includes|"
    r"\.at\(|\.match\(|\.test\(|\.some\(|\.every\(|\.includes\(|new Date|"
    r"Date\.|\\[tbnv]\\.|\.?\$"
)


def keys(tr):
    return [k for k in tr if not k.startswith("_")]


def main():
    bundle_path = find_bundle()
    if not bundle_path:
        print("UI bundle not found - run hanhua.py first to create a backup, or install OpenMausBot.", file=sys.stderr)
        sys.exit(1)
    with open(bundle_path, encoding="utf-8") as fh:
        bundle = fh.read()
    if "backups" in bundle_path:
        print("using pristine backup bundle for key lookup")

    files = sorted(
        f for f in os.listdir(LOCALES_DIR) if f.endswith(".json")
    )
    zh = json.load(open(os.path.join(LOCALES_DIR, "zh-CN.json"), encoding="utf-8"))
    zh_keys = keys(zh)

    print("locale files:", len(files))
    print("base (zh-CN) keys:", len(zh_keys))

    ok = True
    for name in files:
        path = os.path.join(LOCALES_DIR, name)
        try:
            data = json.load(open(path, encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"[{name}] JSON ERROR: {e}")
            ok = False
            continue

        ks = keys(data)
        code = data.get("_meta", {}).get("code")
        print(f"[{name}] code={code} entries={len(ks)}")

        if "_meta" not in data:
            print(f"   MISSING _meta")
            ok = False
        if ks != zh_keys:
            only_here = [k for k in ks if k not in zh_keys]
            missing_here = [k for k in zh_keys if k not in ks]
            if only_here:
                print(f"   EXTRA keys: {only_here[:5]}... ({len(only_here)})")
            if missing_here:
                print(f"   MISSING keys: {missing_here[:5]}... ({len(missing_here)})")
            ok = False

        empty = [k for k in ks if not str(data[k]).strip()]
        if empty:
            print(f"   EMPTY values: {empty[:5]}... ({len(empty)})")
            ok = False

        missing = [k for k in ks if k not in bundle]
        if missing:
            print(f"   NOT in bundle: {missing[:5]}... ({len(missing)})")
            ok = False

        bad = [k for k in ks if DANGEROUS.search(k)]
        if bad:
            print(f"   DANGEROUS keys: {bad[:5]}... ({len(bad)})")
            ok = False

    print("RESULT:", "OK" if ok else "FAILED")


if __name__ == "__main__":
    main()