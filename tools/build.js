// Builds distributable copies of the extension:
//   dist/chrome/   - unpacked, loadable via chrome://extensions
//   dist/firefox/  - unpacked, manifest adjusted for Firefox (about:debugging)
//   dist/*.zip     - zipped copies of both (needs PowerShell on Windows or `zip` elsewhere)
// Run: node tools/build.js

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const include = ["manifest.json", "src", "popup", "icons", "LICENSE", "NOTICE.md", "README.md"];

function copyTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of include) {
    const from = path.join(root, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(target, entry), { recursive: true });
  }
}

function zip(folder, out) {
  fs.rmSync(out, { force: true });
  try {
    if (process.platform === "win32") {
      execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${folder}\\*' -DestinationPath '${out}' -Force"`, { stdio: "inherit" });
    } else {
      execSync(`cd "${folder}" && zip -qr "${out}" .`, { stdio: "inherit" });
    }
    console.log("zipped", path.relative(root, out));
  } catch (err) {
    console.warn("zip step skipped:", err.message);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

// Chrome / Edge / Brave
const chromeDir = path.join(dist, "chrome");
copyTree(chromeDir);
console.log("built dist/chrome");

// Firefox: no service workers for MV3 backgrounds, needs an add-on id, and
// "world": "MAIN" in static content scripts needs Firefox 128+.
const firefoxDir = path.join(dist, "firefox");
copyTree(firefoxDir);
const ffManifest = { ...manifest };
delete ffManifest.minimum_chrome_version;
ffManifest.background = { scripts: ["src/background.js"] };
ffManifest.browser_specific_settings = {
  gecko: { id: "no-twitch-ads@local", strict_min_version: "128.0" },
};
fs.writeFileSync(path.join(firefoxDir, "manifest.json"), JSON.stringify(ffManifest, null, 2) + "\n");
console.log("built dist/firefox");

zip(chromeDir, path.join(dist, `no-twitch-ads-${manifest.version}-chrome.zip`));
zip(firefoxDir, path.join(dist, `no-twitch-ads-${manifest.version}-firefox.zip`));
