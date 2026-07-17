const fs = require("node:fs");
const path = require("node:path");

const inputPath = process.argv[2];
const apiBaseUrl = normalizeApiBaseUrl(process.env.XDT_GIFT_API_BASE_URL || "");
const adminPassword = String(process.env.XDT_GIFT_ADMIN_PASSWORD || "");

if (!inputPath) {
  throw new Error("Usage: node scripts/publish-gift-codes.js <candidate-file.json>");
}

if (!adminPassword) {
  throw new Error("XDT_GIFT_ADMIN_PASSWORD is required.");
}

const artifact = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
if (artifact?.coverage?.status !== "complete") {
  throw new Error("Only a candidate file with complete collection coverage can be published.");
}

const candidates = Array.isArray(artifact.candidates) ? artifact.candidates : [];
const publishable = candidates.filter(isAutoPublishEligible);

if (!publishable.length) {
  console.log("No high-confidence candidates qualified for automatic publishing.");
  process.exit(0);
}

publishCandidates().catch((error) => {
  console.error(`Automatic publishing failed: ${error.message}`);
  process.exitCode = 1;
});

async function publishCandidates() {
  const login = await requestJson("/api/admin/login", {
    method: "POST",
    body: { role: "admin", password: adminPassword }
  });
  const cookie = getSessionCookie(login.response);
  if (!cookie) {
    throw new Error("The admin login response did not include a session cookie.");
  }

  const publish = await requestJson("/api/admin/import-publish", {
    method: "POST",
    cookie,
    body: {
      codes: publishable.map((candidate) => candidate.code),
      candidates: publishable
    }
  });

  console.log(
    JSON.stringify({
      qualified: publishable.length,
      created: publish.payload.created?.length || 0,
      skipped: publish.payload.skipped?.length || 0,
      updatedAt: publish.payload.updatedAt || ""
    })
  );
}

function isAutoPublishEligible(candidate) {
  if (candidate?.autoPublishEligible !== true || candidate.confidence !== "high") {
    return false;
  }

  const code = String(candidate.code || "").trim();
  const evidence = String(candidate.evidence || "").toLowerCase();
  return Boolean(code && evidence.includes(code.toLowerCase()) && isHttpsUrl(candidate.sourceUrl));
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || "")).protocol === "https:";
  } catch {
    return false;
  }
}

async function requestJson(pathname, { method, body, cookie = "" }) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `request_failed_${response.status}`);
  }

  return { response, payload };
}

function getSessionCookie(response) {
  const setCookie = response.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.split(/,(?=\s*[^;=]+=[^;]+)/).find((value) => value.trim().startsWith("admin_session="));
  return sessionCookie ? sessionCookie.split(";")[0].trim() : "";
}

function normalizeApiBaseUrl(value) {
  const normalized = String(value).trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("XDT_GIFT_API_BASE_URL is required.");
  }

  const url = new URL(normalized);
  if (url.protocol !== "https:") {
    throw new Error("XDT_GIFT_API_BASE_URL must use HTTPS.");
  }

  return normalized;
}
