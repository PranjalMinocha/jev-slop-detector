import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
if (manifest.manifest_version !== 3) {
  throw new Error("manifest.json must use Manifest V3.");
}

const scripts = [
  "src/background.js",
  "src/classifier.js",
  "src/content.js",
  "src/linkedin-dom.js",
  "src/popup.js"
];

for (const script of scripts) {
  execFileSync(process.execPath, ["--check", script], { stdio: "inherit" });
}

console.log(`Manifest and ${scripts.length} JavaScript files passed basic checks.`);
