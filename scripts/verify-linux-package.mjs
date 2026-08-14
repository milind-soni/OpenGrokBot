import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(process.argv[2] ?? path.join(root, "release"));

function fail(message) {
  throw new Error(`[verify-linux-package] ${message}`);
}

function exactlyOne(suffix) {
  const matches = readdirSync(releaseDir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(releaseDir, name));
  if (matches.length !== 1) fail(`expected exactly one ${suffix} artifact, found ${matches.length}`);
  return matches[0];
}

function requireFile(file) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) fail(`missing file: ${file}`);
}

function requireExecutable(file) {
  requireFile(file);
  try {
    accessSync(file, constants.X_OK);
  } catch {
    fail(`not executable: ${file}`);
  }
}

const appImage = exactlyOne(".AppImage");
const deb = exactlyOne(".deb");
const unpacked = path.join(releaseDir, "linux-unpacked");
const executable = path.join(unpacked, "openmausbot");
const resources = path.join(unpacked, "resources");

requireExecutable(appImage);
requireExecutable(executable);
for (const relative of ["app.asar", "ui/index.html", "server/index.js"]) {
  requireFile(path.join(resources, relative));
}
for (const forbidden of ["speech-helper", "cua-driver"]) {
  if (statSync(path.join(resources, forbidden), { throwIfNoEntry: false })) {
    fail(`unsupported Linux resource was bundled: ${forbidden}`);
  }
}

const fields = execFileSync(
  "dpkg-deb",
  ["--field", deb, "Package", "Version", "Architecture", "Maintainer", "Section", "Priority"],
  { encoding: "utf8" },
);
for (const expected of [
  "Package: openmausbot",
  "Architecture: amd64",
  "Maintainer: Milind Soni",
  "Section: utils",
  "Priority: optional",
]) {
  if (!fields.includes(expected)) fail(`DEB metadata is missing ${JSON.stringify(expected)}`);
}

const extracted = mkdtempSync(path.join(tmpdir(), "omb-deb-verify-"));
try {
  execFileSync("dpkg-deb", ["--extract", deb, extracted]);
  const desktopFile = path.join(
    extracted,
    "usr",
    "share",
    "applications",
    "com.openmausbot.app.desktop",
  );
  const scalableIcon = path.join(
    extracted,
    "usr",
    "share",
    "icons",
    "hicolor",
    "scalable",
    "apps",
    "openmausbot.svg",
  );
  requireFile(desktopFile);
  requireFile(scalableIcon);
  const desktop = readFileSync(desktopFile, "utf8");
  for (const expected of [
    "Name=OpenMausBot",
    "Exec=/opt/OpenMausBot/openmausbot %U",
    "Icon=openmausbot",
    "StartupWMClass=com.openmausbot.app",
    "Categories=Utility;",
  ]) {
    if (!desktop.includes(expected)) fail(`desktop entry is missing ${JSON.stringify(expected)}`);
  }
  execFileSync("desktop-file-validate", [desktopFile], { stdio: "inherit" });
} finally {
  rmSync(extracted, { recursive: true, force: true });
}

console.log(`[verify-linux-package] OK\n- ${path.basename(appImage)}\n- ${path.basename(deb)}`);
