// electron-builder afterPack hook: strip removable extended attributes from
// the packed .app before signing. Building under an iCloud-synced path (or
// from a provenance-tracked process) leaves xattrs codesign rejects as
// "resource fork, Finder information, or similar detritus not allowed".
// (com.apple.provenance itself is SIP-protected and harmless to codesign;
// FinderInfo/resource forks from the file provider are the killers.)
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  console.log(`  • afterPack: xattr -cr ${appPath}`);
  execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
};
