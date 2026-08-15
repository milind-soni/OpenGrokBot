#!/usr/bin/env node
// DeepSeek Harness ACP launcher for OpenMausBot.
//
// Boots DeepSeek Harness's automation ACP server (Agent Client Protocol over
// JSON-RPC stdio) and forwards stdio + exit status, so the OpenMausBot
// `deepseek` driver can drive DeepSeek agents exactly like the claude/codex/
// grok CLIs.
//
//   --version   print one version line and exit (driver snapshot detection)
//   --model id  override the ACP agent model (default: deepseek-v4-pro)
//
// DEEPSEEK_API_KEY is read from the process environment, or from
// ~/.dsh/.credentials.yaml (the same file `dsh web` uses) when absent.
// DSH_HOME points at a built deepseek-harness checkout (defaults to
// ~/deepseek-harness).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "deepseek-harness-acp 0.1.0-rc.5";
const DSH_HOME = process.env.DSH_HOME || join(homedir(), "deepseek-harness");
const DEFAULT_MODEL = "deepseek-v4-pro";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

let model = DEFAULT_MODEL;
const mi = args.indexOf("--model");
if (mi !== -1 && args[mi + 1]) model = args[mi + 1];

if (!process.env.DEEPSEEK_API_KEY) {
  const cred = join(homedir(), ".dsh", ".credentials.yaml");
  if (existsSync(cred)) {
    try {
      const m = readFileSync(cred, "utf8").match(/^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/m);
      if (m) process.env.DEEPSEEK_API_KEY = m[1].replace(/^["']|["']$/g, "");
    } catch {
      /* unreadable credentials file — leave the key unset and let dsh fail loud */
    }
  }
}

const acpBin = join(DSH_HOME, "packages", "examples", "acp-demo", "lib", "bin.js");
const stockConfig = join(DSH_HOME, "examples", "acp-agent", "cordis.yml");

// The stock acp-agent config hardcodes `model: deepseek-v4-pro`. A different
// model needs a derived config with that one line swapped. It MUST live under
// examples/acp-agent/ — DSH's pnpm layout links the @deepseek-ai workspace
// packages under examples/node_modules, and the Loader resolves those from the
// config file's directory, not the process cwd.
let configPath = stockConfig;
if (model && model !== DEFAULT_MODEL) {
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, "-");
  const yml = readFileSync(stockConfig, "utf8").replace(
    /^(\s*model:)\s*deepseek-v4-pro\s*$/m,
    `$1 ${model}`,
  );
  configPath = join(DSH_HOME, "examples", "acp-agent", `cordis.openmausbot-${safeModel}.yml`);
  writeFileSync(configPath, yml);
}

const child = spawn(process.execPath, [acpBin, "--config", configPath], {
  cwd: DSH_HOME,
  env: process.env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (err) => {
  process.stderr.write(`deepseek-acp: ${err.message}\n`);
  process.exit(1);
});
