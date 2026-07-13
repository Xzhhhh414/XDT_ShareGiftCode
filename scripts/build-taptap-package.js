const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const PACKAGE_NAME = "xdt-share-gift-code";
const PACKAGE_DIR = path.join(DIST_DIR, PACKAGE_NAME);
const ZIP_PATH = path.join(DIST_DIR, `${PACKAGE_NAME}.zip`);
const shouldCreateZip = process.argv.includes("--zip");
const apiBaseUrl = normalizeApiBaseUrl(process.env.TAPTAP_API_BASE_URL || "");

if (shouldCreateZip && !apiBaseUrl) {
  throw new Error("TAPTAP_API_BASE_URL is required when creating a release ZIP.");
}

fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
fs.rmSync(ZIP_PATH, { force: true });
fs.mkdirSync(PACKAGE_DIR, { recursive: true });

for (const file of ["index.html", "styles.css", "script.js"]) {
  fs.copyFileSync(path.join(ROOT_DIR, file), path.join(PACKAGE_DIR, file));
}

for (const directory of ["assets", "data"]) {
  fs.cpSync(path.join(ROOT_DIR, directory), path.join(PACKAGE_DIR, directory), { recursive: true });
}

fs.writeFileSync(
  path.join(PACKAGE_DIR, "runtime-config.js"),
  `window.XDT_GIFT_CODE_CONFIG = Object.freeze({\n  apiBaseUrl: ${JSON.stringify(apiBaseUrl)}\n});\n`,
  "utf8"
);

if (shouldCreateZip) {
  createZip();
  console.log(`TapTap Release package created: ${ZIP_PATH}`);
} else {
  console.log(`TapTap package directory created: ${PACKAGE_DIR}`);
  console.log("Set TAPTAP_API_BASE_URL and run npm run package:taptap to create the release ZIP.");
}

function normalizeApiBaseUrl(value) {
  const normalized = String(value).trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  const url = new URL(normalized);
  if (url.protocol !== "https:") {
    throw new Error("TAPTAP_API_BASE_URL must use HTTPS.");
  }

  return normalized;
}

function createZip() {
  if (process.platform === "win32") {
    execFileSync(
      "tar.exe",
      ["-a", "-c", "-f", ZIP_PATH, "-C", DIST_DIR, PACKAGE_NAME],
      { stdio: "inherit" }
    );
    return;
  }

  execFileSync("zip", ["-qr", ZIP_PATH, PACKAGE_NAME], {
    cwd: DIST_DIR,
    stdio: "inherit"
  });
}
