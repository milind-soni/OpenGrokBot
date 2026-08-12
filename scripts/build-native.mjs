// build-native.mjs — compile the platform-native helpers.
//  speech / perm : macOS-only Swift helpers (compiled with swiftc).
// On non-macOS these are no-ops (Windows uses the bundled .ps1 helper,
// Linux has no dictation/perm helpers yet) — keeping `pnpm package`
// runnable from any platform without a Swift toolchain.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2];

if (process.platform !== "darwin") {
  console.log(`[build-native] skipping ${which ?? ""} (not macOS)`);
  process.exit(0);
}

const JOBS = {
  speech: {
    src: "electron/resources/speech-helper.swift",
    out: "electron/resources/speech-helper",
  },
  perm: {
    src: "electron/resources/perm-helper.swift",
    out: "electron/resources/perm-helper",
  },
};

const job = JOBS[which];
if (!job) {
  console.error(`unknown native helper: ${which}`);
  process.exit(1);
}

const src = path.resolve(__dirname, "..", job.src);
const out = path.resolve(__dirname, "..", job.out);
console.log(`[build-native] compiling ${path.basename(out)}…`);
execFileSync("swiftc", ["-O", src, "-o", out], { stdio: "inherit", timeout: 120_000 });
console.log(`[build-native] done → ${out}`);
