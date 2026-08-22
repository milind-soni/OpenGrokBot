# OpenMausBot 本地化 / Localization

将 [OpenMausBot](https://github.com/milind-soni/OpenMausBot)（Electron 桌面应用）的界面文案替换为任意支持的语言。原理是直接改写已安装应用 `resources/ui` 目录下的 Next.js 编译产物（纯前端静态资源），不改动 `app.asar` 主程序逻辑，风险低、可随时还原。

Localize the UI of the [OpenMausBot](https://github.com/milind-soni/OpenMausBot) desktop app into any supported language. It rewrites the Next.js build output under `resources/ui` (static front-end files only) — the `app.asar` program logic is untouched, so it is low-risk and fully reversible.

> 针对 **v0.1.25** 的 Web UI 编译产物测试通过。其他版本可能因编译产物哈希变化而失效，请按「重新生成词典」更新。
> Tested against the **v0.1.25** Web UI bundle. Other versions may differ (hashed filenames); see "Regenerating the dictionary".

---

## 特性 / Features

- **多语言**：从 `locales/` 目录动态发现语言，新增一个语言文件即可支持，脚本内无任何硬编码语言
  **Multilingual**: languages are discovered dynamically from `locales/` — add a file, no code changes.
- **交互式选择器**：彩色编号菜单，`--lang <code>` 可跳过直接指定
  **Interactive picker** with a numbered menu; `--lang <code>` bypasses it.
- **自动检测**安装目录（Windows / macOS / Linux），也支持 `--path` 手动指定
  **Auto-detects** the install dir; `--path` overrides.
- 自动读取 `app.asar` 内的 `package.json` 识别**版本号** **Auto-reads the version** from the packaged app.
- 应用前**自动备份**，支持 `--restore` 一键还原 **Auto backup** + one-command restore.
- **精确替换**：仅在字符串字面量内部替换，并做双重边界检查（前后字符须为非字母数字，且不能紧邻 JS 运算符），杜绝 `On`→`Connection`、`Date.now()`、`On=!1` 这类误伤
  **Precise matching**: string-literal only, plus a boundary check that rejects matches adjacent to JS operators, so identifiers/code are never mangled.
- 自动剔除**不可翻译**的安全敏感串（键盘键名、被代码比较的常量、JS 类型名等）
  **Auto-excludes** non-translatable, safety-sensitive strings (key names, compared constants, JS type names).
- `--dry-run` 预览 / `--check` 语法自检（需 node.js）/ `--no-backup`
  **--dry-run** preview, **--check** JS syntax validation (needs node.js), **--no-backup**.

---

## 环境要求 / Requirements

- Python 3.8+（无第三方依赖） / no third-party dependencies
- OpenMausBot 桌面应用已安装 / installed OpenMausBot
- 可选：node.js（用于 `--check` 语法自检） / optional: node.js (for `--check`)

## 快速开始 / Quick start

```bash
# 运行并弹出语言选择菜单（自动检测安装目录）
# Run with interactive language picker (auto-detects the install dir)
python hanhua.py

# 直接指定语言 / pick a language directly
python hanhua.py --lang ja-JP
python hanhua.py --lang ru-RU

# 列出所有可用语言 / list available languages
python hanhua.py --list

# 指定安装目录 / point at a specific install dir
python hanhua.py --path "D:\Programs\openmausbot" --lang fr-FR

# 只预览，不写入 / preview only, write nothing
python hanhua.py --dry-run --lang de-DE

# 预览 + 用 node 校验生成的 JS 语法 / preview + validate JS syntax with node
python hanhua.py --dry-run --check --lang ru-RU

# 还原为英文（默认用最早的原始备份）/ restore original English (earliest backup)
python hanhua.py --restore

# 从指定备份还原 / restore from a specific backup
python hanhua.py --restore --backup 0.1.25-20260820-172245

# 应用但不创建备份 / apply without creating a backup
python hanhua.py --no-backup --lang ko-KR
```

Windows 上也可直接双击 `localize.bat`，用编号菜单操作（1 本地化 / 2 还原英文 / 3 列出语言 / 4 退出）。
On Windows you can also double-click `localize.bat` for a numbered menu (1 Localize / 2 Restore English / 3 List / 4 Exit).

**macOS / Linux**：无 `.bat`，直接用 Python 脚本（命令相同，用 `python3`）。脚本会自动识别 macOS `.app` 包内的 `Contents/Resources` 目录，也可用 `--path` 指定：
**macOS / Linux**: no `.bat` — run the Python script directly (same commands, use `python3`). The macOS `.app` bundle layout (`Contents/Resources`) is auto-detected; `--path` also works:
```bash
python3 hanhua.py --dry-run --lang zh-TW   # 先预览 / preview first
python3 hanhua.py --lang zh-TW             # 再应用 / then apply
python3 hanhua.py --restore                # 还原英文 / restore English
```

> **换语言前先还原**：应用已汉化后直接换语言，只替换剩余英文、旧译文不会变。正确顺序：`--restore` 还原英文 → 再 `--lang <code>` 应用新语言。
> **Switch languages via restore first**: if the app is already localized, applying a new language only replaces the remaining English. Do `--restore` first, then apply the new language.

应用完成后 **重启 OpenMausBot** 即可看到目标语言界面。
After applying, **restart OpenMausBot** to see the translated interface.

---

## 支持的语言 / Supported languages

| 代码 / Code | 语言 / Language | 语言文件内注释 / Note in file |
|---|---|---|
| `zh-CN` | 简体中文 | 内置语言，由项目维护 |
| `zh-TW` | 繁體中文 | 社區維護 |
| `ja-JP` | 日本語 | コミュニティ翻訳 |
| `ko-KR` | 한국어 | 커뮤니티 번역 |
| `es-ES` | Español | Traducción de la comunidad |
| `fr-FR` | Français | Traduction de la communauté |
| `de-DE` | Deutsch | Community-Übersetzung |
| `ru-RU` | Русский | Перевод сообщества |

---

## 添加新语言 / Adding a language

1. 复制 `locales/zh-CN.json` 为 `locales/<code>.json`（例如 `pt-BR.json`）
   Copy `locales/zh-CN.json` to `locales/<code>.json` (e.g. `pt-BR.json`).
2. 填写 `_meta`（`code` / `flag` / `name` / `name_en` / `note`），并翻译所有 value。
   Fill in `_meta` and translate every value.
3. **key 必须与 zh-CN 完全一致**——包括前导空格、弯引号 `’`、省略号 `…`、`·`、`→`、emoji 等字符；不得增删。
   **Keys must match zh-CN exactly** — including leading spaces, curly quotes `’`, ellipses `…`, `·`, `→`, emoji; do not add or remove keys.
4. 校验：`python hanhua.py --list` 确认出现新语言；`python hanhua.py --dry-run --check --lang <code>` 预览并自检语法。
   Validate: `hanhua.py --list` then `hanhua.py --dry-run --check --lang <code>`.
5. 全量校验：`python tools/validate_dict.py` 通过后再使用。
   Run `python tools/validate_dict.py` until it reports `RESULT: OK`.

> 翻译值不要包含键盘键名或可能被代码比较的常量词；含 `.` `-` 等符号的值会自动被边界检查拦截在代码位置，但为安全起见仍建议使用普通文字。
> Avoid values that are key names or compared constants; punctuation-heavy values are auto-blocked at code positions by the boundary check, but plain words are safest.

---

## 工作原理 / How it works

1. **发现语言** `discover_locales()`：扫描 `locales/*.json`，读取 `_meta` 生成语言列表（顺序即菜单顺序）。
   Locales are discovered from `_meta` — the file order is the menu order.
2. **定位应用**：常见安装路径 + 按名字扫描；读取 `resources/app.asar` 头部索引内的 `package.json` 得到版本。
   The app dir and version are resolved from standard paths and the asar header.
3. **备份**：复制 `resources/ui` 下待改文件到 `backups/<版本>-<时间戳>/`，写 `manifest.json`（记录源目录、版本）。
   A timestamped backup (with `manifest.json`) is written before any change.
4. **替换**：对每个 UI 文件做一次正则扫描——仅在 `"` / `'` / `` ` `` 字符串字面量内替换，key 按长度降序避免交叉污染，并做边界检查：
   Replacement is a single regex pass over each file. Only matches inside string literals are replaced; keys are sorted longest-first; a boundary check rejects any match whose neighbors are alphanumeric, `_`/`$`, or JS operators (`= ! ? : ; , ( ) [ ] { } < > + - * / % & | ^ ~ \`). This is what keeps code such as `var $t=null,On=!1` intact while still translating the UI string `"On"`.
   - 字符串字面量内部（`scan_literals`）
   - 边界：前/后字符不能是字母数字、`_$`、或 JS 运算符
   - 按目标语言转义引号与 `${`（模板字符串内）
5. **注入**：`index.html` 的 `<html lang="en">` 改为目标语言代码。
   The `<html lang>` attribute is set to the language code.
6. **自检（可选）**：`--check` 调用 `node --check` 验证产物语法。

---

## 安全说明 / Safety

- 仅改动 `resources/ui` 下的静态 JS/HTML，不触碰 `app.asar`。
  Only static files under `resources/ui` are touched.
- 所有 key 在写入前经 `tools/validate_dict.py` 用**备份中的原始 bundle** 校验为原包子串。
  Keys are validated against the **pristine backup bundle** before writing.
- 关键逻辑串（键盘键名、`Browser`/`Android`/`Deny`/`Allow` 等比较常量、`Date`/`Worker` 等 JS 类型名、`Files` 剪贴板类型）在词典生成阶段即被排除。
  Safety-critical strings are excluded at dictionary-build time.
- 文件以 UTF-8 无 BOM 写回；每处替换均按原引号类型转义。
  Files are written as UTF-8 without BOM; values are escaped per the surrounding quote type.
- 如某次替换异常，用 `--restore` 还原；备份含 `manifest.json` 记录来源目录。
  If anything looks wrong, `--restore` reverts from the latest backup.

---

## 重新生成词典 / Regenerating the dictionary (new app versions)

`tools/` 提供提取与校验工具链 / helper tools live in `tools/`:

1. `tools/extract_strings.py`：从 UI 主包提取候选字符串 → `candidates.json`
   Extract candidate strings from the UI bundle.
2. 人工筛选出可翻译 UI 文案，写入 `locales/zh-CN.json`（key = 原文，value = 中文），再同步补齐其他语言文件。
   Curate the strings into `locales/zh-CN.json`, then update the other languages to match.
3. `tools/validate_dict.py`：校验所有语言文件的 key 集与 zh-CN 一致、每个 key 都是原始 bundle 的子串、无危险用法（`toLowerCase`/`includes`/`===`/`new Date` 等）。
   Validates: identical key sets, all keys are substrings of the pristine bundle, no dangerous usages.
4. `tools/check_keys.py`：扫描 key 是否以 `case` 标签 / `===` 比较 / `.includes()` 等危险方式出现，命中则剔除。
   Scans keys for dangerous code usages and drops them.
5. `tools/verify_lang.py <code>`：对已安装 UI 做幂等性校验——重跑应零改动（`REAPPLY_COUNT: 0`）、无残留英文 key、语言属性匹配、无外来脚本字符，全部通过输出 `VERDICT: OK`。
   Verifies the installed UI is idempotent (`REAPPLY_COUNT: 0`), has no residual untranslated keys, correct `lang` attribute, and no foreign script characters.

---

## 目录结构 / Project structure

```
hanhua.py              主脚本（多语言，含交互式选择器） / main script
locales/               语言词典目录 / language dictionaries
  zh-CN.json           基准词典（590 条 + _meta，key 以此为准）
  zh-TW.json  ja-JP.json  ko-KR.json  es-ES.json  fr-FR.json  de-DE.json  ru-RU.json
backups/               （运行时生成）备份 / runtime backups
tools/                 提取与校验工具 / extraction & validation tools
README.md              本文档
```

---

## 常见问题 / Troubleshooting

| 问题 / Problem | 解决 / Fix |
|---|---|
| `OpenMausBot not found` | 用 `--path` 指定安装目录 / pass `--path`. |
| `Cannot write ...` | 应用正在运行，先退出 OpenMausBot 再执行 / quit the app first. |
| 替换数量为 0 | 应用可能已被汉化，或版本不匹配需重新生成词典 / already translated, or regenerate the dictionary. |
| `--check` 显示需 node | 安装 node.js 后重试，或省略 `--check` / install node.js or drop `--check`. |
| 想恢复英文 | `python hanhua.py --restore`（默认还原最早的原始备份），重启应用 / restore & restart. |

---

## License

MIT