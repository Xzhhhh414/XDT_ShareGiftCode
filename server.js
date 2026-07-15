const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = __dirname;
const SERVER_DIR = path.join(ROOT_DIR, "server");
const DB_PATH = path.join(SERVER_DIR, "db.json");
const SEED_PATH = path.join(SERVER_DIR, "db.seed.json");
const DATA_STORE = process.env.DATA_STORE || "json";
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || path.join(SERVER_DIR, "db.sqlite");
const MAX_BODY_BYTES = 64000;
const MAX_IMPORT_CANDIDATES = 50;
const PENDING_REWARD_TEXT = "奖励待确认";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SESSION_SECRET = crypto.createHash("sha256").update(`xdt-share-gift-code-session:${ADMIN_PASSWORD}`).digest("base64url");
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SERVE_PLAYER_STATIC = process.env.SERVE_PLAYER_STATIC !== "false";
const PLAYER_CORS_ORIGINS = new Set(
  String(process.env.PLAYER_CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const loginAttempts = new Map();
let dbMutationQueue = Promise.resolve();
let sqliteDatabase = null;

if (!["json", "sqlite"].includes(DATA_STORE)) {
  throw new Error("DATA_STORE must be json or sqlite.");
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    if (url.pathname === "/admin.html" && !getAdminSession(request)) {
      redirect(response, "/login.html");
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(response, error.statusCode, { error: error.code });
      return;
    }

    console.error(error);
    sendJson(response, 500, { error: "internal_server_error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`XDT Share Gift Code running at http://${HOST}:${PORT}`);
});

async function handleApi(request, response, url) {
  if (isPlayerApiPath(url.pathname)) {
    if (request.method === "OPTIONS") {
      handlePlayerCorsPreflight(request, response);
      return;
    }

    applyPlayerCors(request, response);
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/gift-codes") {
    const db = await readDb();
    sendJson(response, 200, toClientPayload(db));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    sendJson(response, 200, { authenticated: Boolean(getAdminSession(request)), configured: isAdminAuthConfigured() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    await loginAdmin(request, response, await readBody(request));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    requireAdmin(request);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": clearAdminSessionCookie(request) });
    return;
  }

  if (url.pathname.startsWith("/api/admin/")) {
    requireAdmin(request);
    if (request.method !== "GET") {
      requireSameOrigin(request);
    }
  }

  if (request.method === "GET" && url.pathname === "/api/admin/overview") {
    const db = await readDb();
    sendJson(response, 200, toAdminPayload(db));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/import-preview") {
    await previewImportedCandidates(response, await readBody(request));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/import-publish") {
    await publishImportedCandidates(response, await readBody(request));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/submissions") {
    await createSubmission(response, await readBody(request));
    return;
  }

  const submissionReviewMatch = url.pathname.match(/^\/api\/admin\/submissions\/([^/]+)\/review$/);
  if (request.method === "POST" && submissionReviewMatch) {
    await reviewSubmission(response, submissionReviewMatch[1], await readBody(request));
    return;
  }

  const rewardReviewMatch = url.pathname.match(/^\/api\/admin\/reward-feedback\/([^/]+)\/review$/);
  if (request.method === "POST" && rewardReviewMatch) {
    await reviewRewardFeedback(response, rewardReviewMatch[1], await readBody(request));
    return;
  }

  const codeActionMatch = url.pathname.match(/^\/api\/admin\/gift-codes\/([^/]+)\/(takedown|restore)$/);
  if (request.method === "POST" && codeActionMatch) {
    await updateCodeVisibility(response, codeActionMatch[1], codeActionMatch[2], await readBody(request));
    return;
  }

  const feedbackMatch = url.pathname.match(/^\/api\/gift-codes\/([^/]+)\/feedback$/);
  if (request.method === "POST" && feedbackMatch) {
    await createFeedback(response, feedbackMatch[1], await readBody(request));
    return;
  }

  const rewardMatch = url.pathname.match(/^\/api\/gift-codes\/([^/]+)\/reward-feedback$/);
  if (request.method === "POST" && rewardMatch) {
    await createRewardFeedback(response, rewardMatch[1], await readBody(request));
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function createFeedback(response, rawCode, body) {
  const code = normalizeCode(decodeRouteCode(rawCode));
  const result = String(body.result || "").trim();

  if (!["valid", "invalid"].includes(result)) {
    sendJson(response, 400, { error: "invalid_result" });
    return;
  }

  const payload = await mutateDb(async (db) => {
    const codeItem = findCode(db, code);
    if (!codeItem) {
      throw new ApiError(404, "code_not_found");
    }

    const createdAt = new Date().toISOString();
    const feedback = {
      code,
      result,
      createdAt,
      clientId: getClientId(body)
    };

    db.feedback = [...(db.feedback || []), feedback];

    if (result === "invalid" && !codeItem.expireAt && codeItem.visible !== false) {
      codeItem.visible = false;
      codeItem.hiddenAt = createdAt;
      codeItem.hiddenReason = "玩家反馈失效";
      codeItem.updatedAt = createdAt;
    }

    db.updatedAt = createdAt;

    return {
      latestFeedback: toClientFeedback(feedback),
      visible: codeItem.visible !== false,
      updatedAt: db.updatedAt
    };
  });

  sendJson(response, 201, payload);
}

async function createRewardFeedback(response, rawCode, body) {
  const code = normalizeCode(decodeRouteCode(rawCode));
  const reward = String(body.reward || "").trim().replace(/\s+/g, " ");

  if (!reward || reward.length > 80) {
    sendJson(response, 400, { error: "invalid_reward" });
    return;
  }

  const payload = await mutateDb(async (db) => {
    if (!findCode(db, code)) {
      throw new ApiError(404, "code_not_found");
    }

    const rewardFeedback = {
      id: createId("reward"),
      code,
      reward,
      reviewStatus: "pending",
      createdAt: new Date().toISOString(),
      clientId: getClientId(body)
    };

    db.rewardFeedback = [...(db.rewardFeedback || []), rewardFeedback];
    db.updatedAt = rewardFeedback.createdAt;

    return {
      reviewStatus: rewardFeedback.reviewStatus,
      updatedAt: db.updatedAt
    };
  });

  sendJson(response, 201, payload);
}

async function createSubmission(response, body) {
  const title = String(body.title || "").trim().replace(/\s+/g, " ");
  const code = normalizeSubmittedCode(body.code);
  const reward = String(body.reward || "").trim().replace(/\s+/g, " ");
  const expireAt = String(body.expireAt || "").trim();
  const sourceUrl = String(body.sourceUrl || "").trim();
  const note = String(body.note || "").trim().replace(/\s+/g, " ").slice(0, 160);

  if (!title || title.length > 40) {
    sendJson(response, 400, { error: "invalid_title" });
    return;
  }

  if (!code) {
    sendJson(response, 400, { error: "invalid_code" });
    return;
  }

  if (!reward || reward.length > 80) {
    sendJson(response, 400, { error: "invalid_reward" });
    return;
  }

  if (!isValidDateOnly(expireAt)) {
    sendJson(response, 400, { error: "invalid_expire_at" });
    return;
  }

  const payload = await mutateDb(async (db) => {
    if (findCode(db, normalizeCode(code))) {
      throw new ApiError(409, "code_already_exists");
    }

    if (findPendingSubmission(db, code)) {
      throw new ApiError(409, "submission_already_exists");
    }

    const submission = {
      id: createId("sub"),
      title,
      code,
      reward,
      expireAt,
      sourceUrl,
      note,
      reviewStatus: "pending",
      createdAt: new Date().toISOString(),
      clientId: getClientId(body)
    };

    db.submissions = [...(db.submissions || []), submission];
    db.updatedAt = submission.createdAt;

    return {
      submission: toClientSubmission(submission),
      updatedAt: db.updatedAt
    };
  });

  sendJson(response, 201, payload);
}

async function previewImportedCandidates(response, body) {
  const candidates = normalizeImportedCandidates(body.candidates);
  const db = await readDb();

  sendJson(response, 200, {
    candidates: candidates.map((candidate) => withCandidateStatus(db, candidate))
  });
}

async function publishImportedCandidates(response, body) {
  const parsedCandidates = normalizeImportedCandidates(body.candidates);
  const requestedCodes = Array.isArray(body.codes)
    ? new Set(body.codes.map(normalizeCode).filter(Boolean))
    : null;
  const candidates = parsedCandidates.filter((candidate) => !requestedCodes || requestedCodes.has(normalizeCode(candidate.code)));

  if (!candidates.length) {
    throw new ApiError(400, "source_candidates_empty");
  }

  const payload = await mutateDb(async (db) => {
    const createdAt = new Date().toISOString();
    const created = [];
    const skipped = [];

    for (const candidate of candidates) {
      const status = getCandidateDuplicateStatus(db, candidate.code);
      if (status !== "new") {
        skipped.push({ ...candidate, duplicateStatus: status });
        continue;
      }

      const code = createGiftCodeFromCandidate(candidate, createdAt);
      db.codes = [...(db.codes || []), code];
      created.push(toAdminCode(code));
    }

    if (created.length) {
      db.updatedAt = createdAt;
    }

    return {
      created,
      skipped,
      updatedAt: db.updatedAt
    };
  });

  sendJson(response, 201, payload);
}

async function updateCodeVisibility(response, rawCode, action, body) {
  const codeValue = normalizeCode(decodeRouteCode(rawCode));

  const payload = await mutateDb(async (db) => {
    const code = findCode(db, codeValue);
    if (!code) {
      throw new ApiError(404, "code_not_found");
    }

    const updatedAt = new Date().toISOString();

    if (action === "takedown") {
      code.visible = false;
      code.hiddenAt = updatedAt;
      code.hiddenReason = String(body.reason || "后台手动下架").trim().replace(/\s+/g, " ").slice(0, 80);
    } else {
      code.visible = true;
      code.restoredAt = updatedAt;
    }

    code.updatedAt = updatedAt;
    db.updatedAt = updatedAt;

    return {
      code: toAdminCode(code),
      updatedAt: db.updatedAt
    };
  });

  sendJson(response, 200, payload);
}

async function reviewSubmission(response, submissionId, body) {
  const decision = normalizeReviewDecision(body.decision);

  if (!decision) {
    sendJson(response, 400, { error: "invalid_decision" });
    return;
  }

  const payload = await mutateDb(async (db) => {
    const submission = (db.submissions || []).find((item) => item.id === submissionId);

    if (!submission) {
      throw new ApiError(404, "submission_not_found");
    }

    if (submission.reviewStatus !== "pending") {
      throw new ApiError(409, "submission_already_reviewed");
    }

    const reviewedAt = new Date().toISOString();

    if (decision === "approved") {
      const normalizedCode = normalizeCode(submission.code);
      if (findCode(db, normalizedCode)) {
        throw new ApiError(409, "code_already_exists");
      }

      db.codes = [
        ...(db.codes || []),
        {
          code: submission.code,
          title: submission.title,
          game: "心动小镇",
          status: submission.expireAt ? "active" : "unknown",
          reward: submission.reward,
          expireAt: submission.expireAt ? `${submission.expireAt}T23:59:59+08:00` : "",
          sourcePlatform: submission.sourcePlatform || "player",
          sourceUrl: submission.sourceUrl,
          firstSeenAt: reviewedAt,
          lastSeenAt: reviewedAt,
          sourceCount: 1,
          copiedCount: 0
        }
      ];
    }

    submission.reviewStatus = decision;
    submission.reviewedAt = reviewedAt;
    db.updatedAt = reviewedAt;

    return {
      submission: toClientSubmission(submission),
      updatedAt: db.updatedAt
    };
  });

  sendJson(response, 200, payload);
}

async function reviewRewardFeedback(response, rewardFeedbackId, body) {
  const decision = normalizeReviewDecision(body.decision);

  if (!decision) {
    sendJson(response, 400, { error: "invalid_decision" });
    return;
  }

  const payload = await mutateDb(async (db) => {
    const rewardFeedback = (db.rewardFeedback || []).find((item) => item.id === rewardFeedbackId);

    if (!rewardFeedback) {
      throw new ApiError(404, "reward_feedback_not_found");
    }

    if (rewardFeedback.reviewStatus !== "pending") {
      throw new ApiError(409, "reward_feedback_already_reviewed");
    }

    if (!findCode(db, normalizeCode(rewardFeedback.code))) {
      throw new ApiError(404, "code_not_found");
    }

    const reviewedAt = new Date().toISOString();
    rewardFeedback.reviewStatus = decision;
    rewardFeedback.reviewedAt = reviewedAt;
    db.updatedAt = reviewedAt;

    return {
      rewardFeedback,
      updatedAt: db.updatedAt
    };
  });

  sendJson(response, 200, payload);
}

async function loginAdmin(request, response, body) {
  if (!isAdminAuthConfigured()) {
    throw new ApiError(503, "admin_auth_not_configured");
  }

  const clientKey = getClientAddress(request);
  const attempt = loginAttempts.get(clientKey);
  if (attempt && attempt.count >= LOGIN_MAX_ATTEMPTS && Date.now() - attempt.startedAt < LOGIN_WINDOW_MS) {
    throw new ApiError(429, "login_rate_limited");
  }

  const password = String(body.password || "");
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    recordFailedLogin(clientKey);
    throw new ApiError(401, "invalid_admin_password");
  }

  loginAttempts.delete(clientKey);
  sendJson(response, 200, { ok: true }, { "Set-Cookie": createAdminSessionCookie(request) });
}

function isAdminAuthConfigured() {
  return Boolean(ADMIN_PASSWORD);
}

function requireAdmin(request) {
  if (!isAdminAuthConfigured()) {
    throw new ApiError(503, "admin_auth_not_configured");
  }

  if (!getAdminSession(request)) {
    throw new ApiError(401, "admin_auth_required");
  }
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) {
    return;
  }

  const expectedOrigin = `${getRequestProtocol(request)}://${request.headers.host}`;
  if (origin !== expectedOrigin) {
    throw new ApiError(403, "invalid_admin_origin");
  }
}

function getAdminSession(request) {
  if (!isAdminAuthConfigured()) {
    return null;
  }

  const value = parseCookies(request.headers.cookie || "").admin_session;
  if (!value) {
    return null;
  }

  const separator = value.lastIndexOf(".");
  if (separator < 1) {
    return null;
  }

  const encodedPayload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expectedSignature = signAdminSession(encodedPayload);
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    return Number(payload.expiresAt) > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function createAdminSessionCookie(request) {
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
  const payload = Buffer.from(JSON.stringify({ expiresAt, nonce: crypto.randomBytes(16).toString("hex") })).toString("base64url");
  const value = `${payload}.${signAdminSession(payload)}`;
  return buildAdminSessionCookie(request, value, ADMIN_SESSION_TTL_SECONDS);
}

function clearAdminSessionCookie(request) {
  return buildAdminSessionCookie(request, "", 0);
}

function buildAdminSessionCookie(request, value, maxAge) {
  const secure = getRequestProtocol(request) === "https" ? "; Secure" : "";
  return `admin_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function signAdminSession(payload) {
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("base64url");
}

function parseCookies(header) {
  return header.split(";").reduce((cookies, item) => {
    const separator = item.indexOf("=");
    if (separator > 0) {
      cookies[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
    }
    return cookies;
  }, {});
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getRequestProtocol(request) {
  return String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (request.socket.encrypted ? "https" : "http");
}

function getClientAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function recordFailedLogin(clientKey) {
  const now = Date.now();
  const previous = loginAttempts.get(clientKey);
  const current = previous && now - previous.startedAt < LOGIN_WINDOW_MS ? previous : { count: 0, startedAt: now };
  current.count += 1;
  loginAttempts.set(clientKey, current);
}

async function serveStatic(response, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const absolutePath = path.resolve(ROOT_DIR, `.${requestPath}`);

  if (!absolutePath.startsWith(ROOT_DIR) || !isPublicPath(requestPath)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(absolutePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(absolutePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(file);
  } catch {
    sendText(response, 404, "Not found");
  }
}

function isPublicPath(requestPath) {
  const playerPaths =
    requestPath === "/index.html" ||
    requestPath === "/styles.css" ||
    requestPath === "/script.js" ||
    requestPath === "/runtime-config.js" ||
    requestPath.startsWith("/data/") ||
    requestPath.startsWith("/assets/");

  return (
    requestPath === "/login.html" ||
    requestPath === "/admin.html" ||
    requestPath === "/admin.js" ||
    requestPath === "/login.js" ||
    requestPath === "/styles.css" ||
    (SERVE_PLAYER_STATIC && playerPaths)
  );
}

function isPlayerApiPath(pathname) {
  return (
    pathname === "/api/gift-codes" ||
    pathname === "/api/submissions" ||
    /^\/api\/gift-codes\/[^/]+\/(feedback|reward-feedback)$/.test(pathname)
  );
}

function applyPlayerCors(request, response) {
  const origin = String(request.headers.origin || "").trim();
  if (!origin || !PLAYER_CORS_ORIGINS.has(origin)) {
    return false;
  }

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  return true;
}

function handlePlayerCorsPreflight(request, response) {
  if (!applyPlayerCors(request, response)) {
    sendJson(response, 403, { error: "cors_origin_not_allowed" });
    return;
  }

  response.writeHead(204, {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "600"
  });
  response.end();
}

async function readDb() {
  if (DATA_STORE === "sqlite") {
    return readSqliteDb();
  }

  await fs.mkdir(SERVER_DIR, { recursive: true });

  try {
    return JSON.parse(await fs.readFile(DB_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const seed = await fs.readFile(SEED_PATH, "utf8");
    await fs.writeFile(DB_PATH, seed);
    return JSON.parse(seed);
  }
}

async function writeDb(db) {
  if (DATA_STORE === "sqlite") {
    writeSqliteDb(db);
    return;
  }

  await fs.writeFile(DB_PATH, `${JSON.stringify(db, null, 2)}\n`);
}

function readSqliteDb() {
  const row = getSqliteDatabase()
    .prepare("SELECT payload FROM app_state WHERE id = 1")
    .get();

  if (!row?.payload) {
    throw new Error("SQLite app state is missing.");
  }

  return JSON.parse(row.payload);
}

function writeSqliteDb(db) {
  getSqliteDatabase()
    .prepare("UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(db), new Date().toISOString());
}

function getSqliteDatabase() {
  if (sqliteDatabase) {
    return sqliteDatabase;
  }

  fsSync.mkdirSync(path.dirname(SQLITE_DB_PATH), { recursive: true });
  sqliteDatabase = new DatabaseSync(SQLITE_DB_PATH);
  sqliteDatabase.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const existing = sqliteDatabase
    .prepare("SELECT id FROM app_state WHERE id = 1")
    .get();
  if (!existing) {
    const initialState = readInitialDbState();
    sqliteDatabase
      .prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?)")
      .run(JSON.stringify(initialState), new Date().toISOString());
  }

  return sqliteDatabase;
}

function readInitialDbState() {
  try {
    return JSON.parse(fsSync.readFileSync(DB_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return JSON.parse(fsSync.readFileSync(SEED_PATH, "utf8"));
}

function mutateDb(mutator) {
  const operation = dbMutationQueue.catch(() => {}).then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });

  dbMutationQueue = operation.then(
    () => undefined,
    () => undefined
  );

  return operation;
}

function toClientPayload(db) {
  return {
    updatedAt: db.updatedAt,
    codes: (db.codes || []).map((code) => toClientCode(db, code))
  };
}

function toAdminPayload(db) {
  return {
    updatedAt: db.updatedAt,
    codes: [...(db.codes || [])].sort(sortAdminCodes).map(toAdminCode),
    submissions: [...(db.submissions || [])].sort(sortAdminReviewItems).map(toClientSubmission),
    rewardFeedback: [...(db.rewardFeedback || [])].sort(sortAdminReviewItems).map(toClientRewardFeedback),
    feedback: [...(db.feedback || [])].sort(sortByCreatedAtDesc)
  };
}

function toClientCode(db, code) {
  const normalizedCode = normalizeCode(code.code);
  const latestFeedback = getLatestFeedback(db, normalizedCode) || code.latestFeedback || null;
  const approvedReward = getLatestApprovedReward(db, normalizedCode);

  return {
    ...code,
    sourceReward: code.reward,
    reward: approvedReward?.reward || code.reward,
    latestFeedback: latestFeedback ? normalizeFeedback(latestFeedback) : undefined
  };
}

function getLatestFeedback(db, code) {
  return (db.feedback || [])
    .filter((feedback) => normalizeCode(feedback.code) === code)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

function getLatestApprovedReward(db, code) {
  return (db.rewardFeedback || [])
    .filter((feedback) => normalizeCode(feedback.code) === code && feedback.reviewStatus === "approved")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

function normalizeFeedback(feedback) {
  if (!feedback) {
    return null;
  }

  return {
    result: feedback.result,
    at: feedback.at || feedback.createdAt
  };
}

function toClientFeedback(feedback) {
  return {
    result: feedback.result,
    at: feedback.createdAt
  };
}

function findCode(db, code) {
  return (db.codes || []).find((item) => normalizeCode(item.code) === code);
}

function findPendingSubmission(db, code) {
  const normalizedCode = normalizeCode(code);
  return (db.submissions || []).find(
    (item) => normalizeCode(item.code) === normalizedCode && item.reviewStatus !== "rejected"
  );
}

function createGiftCodeFromCandidate(candidate, createdAt) {
  const sourceUrl = candidate.sourceUrl || "";
  const sourcePlatform = candidate.sourcePlatform || inferSourcePlatform(sourceUrl);

  return {
    code: candidate.code,
    title: candidate.title,
    game: "心动小镇",
    status: candidate.expireAt ? "active" : "unknown",
    reward: candidate.reward,
    expireAt: candidate.expireAt ? `${candidate.expireAt}T23:59:59+08:00` : "",
    sourcePlatform,
    sourceUrl,
    sourceNote: candidate.note,
    visible: true,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
    sourceCount: 1,
    copiedCount: 0,
    createdAt,
    updatedAt: createdAt
  };
}

function normalizeImportedCandidates(candidates) {
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > MAX_IMPORT_CANDIDATES) {
    throw new ApiError(400, "invalid_import_candidates");
  }

  const normalized = candidates.map(normalizeImportedCandidate).filter(Boolean);
  if (!normalized.length) {
    throw new ApiError(400, "invalid_import_candidates");
  }

  return mergeImportedCandidates(normalized);
}

function normalizeImportedCandidate(candidate) {
  const code = normalizeSubmittedCode(candidate?.code);
  const title = String(candidate?.title || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const reward = String(candidate?.reward || PENDING_REWARD_TEXT).trim().replace(/\s+/g, " ").slice(0, 80);
  const expireAt = String(candidate?.expireAt || "").trim();
  const sourceUrl = String(candidate?.sourceUrl || "").trim();
  const evidence = String(candidate?.evidence || candidate?.note || "").trim().replace(/\s+/g, " ").slice(0, 180);
  const sourcePlatform = ["taptap", "xiaohongshu", "other"].includes(candidate?.sourcePlatform)
    ? candidate.sourcePlatform
    : inferSourcePlatform(sourceUrl);

  if (!isValidGiftCodeShape(code) || !title || !evidence || isRejectedCodeEvidence(code, evidence) || (expireAt && !isValidDateOnly(expireAt))) {
    return null;
  }

  if (sourceUrl && !isHttpUrl(sourceUrl)) {
    return null;
  }

  return {
    code,
    title,
    reward: reward || PENDING_REWARD_TEXT,
    expireAt,
    sourceUrl,
    sourcePlatform,
    note: evidence,
    confidence: candidate?.confidence === "high" ? "high" : candidate?.confidence === "low" ? "low" : "medium"
  };
}

function mergeImportedCandidates(candidates) {
  const candidatesByCode = new Map();

  for (const candidate of candidates) {
    const key = normalizeCode(candidate.code);
    const existing = candidatesByCode.get(key);
    if (!existing || getConfidenceRank(candidate.confidence) > getConfidenceRank(existing.confidence)) {
      candidatesByCode.set(key, candidate);
    }
  }

  return [...candidatesByCode.values()];
}

function toAdminCode(code) {
  return {
    code: code.code,
    title: code.title,
    status: code.status,
    reward: code.reward,
    expireAt: code.expireAt,
    sourcePlatform: code.sourcePlatform,
    sourceUrl: code.sourceUrl,
    visible: code.visible !== false,
    firstSeenAt: code.firstSeenAt,
    lastSeenAt: code.lastSeenAt,
    sourceCount: code.sourceCount,
    copiedCount: code.copiedCount,
    hiddenAt: code.hiddenAt,
    hiddenReason: code.hiddenReason,
    restoredAt: code.restoredAt,
    updatedAt: code.updatedAt
  };
}

function normalizeCode(code) {
  return String(code || "").trim().toLowerCase();
}

function decodeRouteCode(rawCode) {
  try {
    return decodeURIComponent(rawCode);
  } catch {
    throw new ApiError(400, "invalid_code");
  }
}

function normalizeSubmittedCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function toClientSubmission(submission) {
  return {
    id: submission.id,
    title: submission.title,
    code: submission.code,
    reward: submission.reward,
    expireAt: submission.expireAt,
    sourceUrl: submission.sourceUrl,
    sourcePlatform: submission.sourcePlatform,
    note: submission.note,
    reviewStatus: submission.reviewStatus,
    createdAt: submission.createdAt,
    reviewedAt: submission.reviewedAt
  };
}

function toClientRewardFeedback(rewardFeedback) {
  return {
    id: rewardFeedback.id,
    code: rewardFeedback.code,
    reward: rewardFeedback.reward,
    reviewStatus: rewardFeedback.reviewStatus,
    createdAt: rewardFeedback.createdAt,
    reviewedAt: rewardFeedback.reviewedAt
  };
}

function sortAdminReviewItems(a, b) {
  const statusDiff = getReviewStatusPriority(a.reviewStatus) - getReviewStatusPriority(b.reviewStatus);
  if (statusDiff !== 0) {
    return statusDiff;
  }

  return sortByCreatedAtDesc(a, b);
}

function getReviewStatusPriority(status) {
  return status === "pending" ? 0 : 1;
}

function sortByCreatedAtDesc(a, b) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

function sortAdminCodes(a, b) {
  const visibleDiff = Number(a.visible === false) - Number(b.visible === false);
  if (visibleDiff !== 0) {
    return visibleDiff;
  }

  return getCodeSortTime(b) - getCodeSortTime(a);
}

function getCodeSortTime(code) {
  const date = new Date(code.updatedAt || code.firstSeenAt || code.lastSeenAt || 0);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}

function normalizeReviewDecision(decision) {
  const value = String(decision || "").trim();
  return ["approved", "rejected"].includes(value) ? value : "";
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00+08:00`);
  return !Number.isNaN(date.getTime());
}

async function normalizeSourceInput(body) {
  const sourceUrl = String(body.sourceUrl || "").trim();
  const fallbackSourceText = normalizeFullWidth(String(body.sourceText || "")).trim();

  if (sourceUrl && !isHttpUrl(sourceUrl)) {
    throw new ApiError(400, "invalid_source_url");
  }

  const sourcePlatform = inferSourcePlatform(sourceUrl);

  let sourceText = "";
  let sourceTextOrigin = "manual";

  if (sourceUrl) {
    try {
      sourceText = await fetchSourceText(sourceUrl);
      sourceTextOrigin = "url";
    } catch (error) {
      if (!fallbackSourceText) {
        throw new ApiError(400, "source_fetch_failed");
      }
    }
  }

  if (!sourceText) {
    sourceText = fallbackSourceText;
  }

  if (sourceText.length < 5 || sourceText.length > MAX_SOURCE_TEXT_LENGTH) {
    throw new ApiError(400, "invalid_source_text");
  }

  return {
    sourcePlatform,
    sourceUrl,
    sourceText,
    sourceTextOrigin
  };
}

async function fetchSourceText(sourceUrl) {
  const document = await fetchSourceDocument(sourceUrl);
  return document.text;
}

async function fetchSourceDocument(sourceUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: "text/html, text/plain;q=0.9, */*;q=0.8",
        "User-Agent": "XDT-ShareGiftCode-LocalParser/0.1"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error("source response not ok");
    }

    const contentType = response.headers.get("content-type") || "";
    const rawText = await response.text();
    const text = contentType.includes("html") ? htmlToText(rawText) : rawText;
    const normalizedText = normalizeFullWidth(text).replace(/\s+/g, " ").trim();

    if (!normalizedText) {
      throw new Error("source text empty");
    }

    return {
      url: sourceUrl,
      contentType,
      rawText,
      text: normalizedText.slice(0, MAX_SOURCE_TEXT_LENGTH)
    };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeCrawlInput(body) {
  const rawSeedUrls = Array.isArray(body.seedUrls)
    ? body.seedUrls
    : String(body.seedUrls || body.urls || "")
        .split(/\s+/)
        .filter(Boolean);

  const seedUrls = [];
  const seenUrls = new Set();

  for (const rawUrl of rawSeedUrls) {
    const value = String(rawUrl || "").trim();
    if (!value) {
      continue;
    }

    if (!isHttpUrl(value)) {
      throw new ApiError(400, "invalid_crawl_url");
    }

    const normalizedUrl = normalizeCrawlUrl(value);
    if (!seenUrls.has(normalizedUrl)) {
      seenUrls.add(normalizedUrl);
      seedUrls.push(normalizedUrl);
    }
  }

  if (!seedUrls.length || seedUrls.length > MAX_CRAWL_SEED_URLS) {
    throw new ApiError(400, "invalid_crawl_urls");
  }

  const maxPages = clampInteger(body.maxPages, 1, MAX_CRAWL_PAGES, Math.min(seedUrls.length + 3, MAX_CRAWL_PAGES));
  const maxDepth = clampInteger(body.maxDepth, 0, MAX_CRAWL_DEPTH, 1);

  return {
    seedUrls,
    maxPages,
    maxDepth
  };
}

async function crawlSources(crawlInput) {
  const allowedHosts = new Set(crawlInput.seedUrls.map((seedUrl) => new URL(seedUrl).hostname.toLowerCase()));
  const queue = crawlInput.seedUrls.map((url) => ({ url, depth: 0 }));
  const visited = new Set();
  const documents = [];
  const pages = [];

  while (queue.length && visited.size < crawlInput.maxPages) {
    const item = queue.shift();
    const normalizedUrl = normalizeCrawlUrl(item.url);
    if (visited.has(normalizedUrl)) {
      continue;
    }

    visited.add(normalizedUrl);

    try {
      const document = await fetchSourceDocument(normalizedUrl);
      const sourceInput = {
        sourcePlatform: inferSourcePlatform(normalizedUrl),
        sourceUrl: normalizedUrl,
        sourceText: document.text,
        sourceTextOrigin: "crawl"
      };
      const pageDocuments = extractLlmDocumentsFromSource(sourceInput);
      documents.push(...pageDocuments);

      pages.push({
        url: normalizedUrl,
        status: "fetched",
        depth: item.depth,
        matchedBlockCount: pageDocuments.length,
        candidateCount: 0
      });

      if (item.depth < crawlInput.maxDepth && isHtmlDocument(document)) {
        const links = extractCrawlLinks(document.rawText, normalizedUrl, allowedHosts);
        for (const link of links) {
          if (!visited.has(link) && !queue.some((queued) => queued.url === link)) {
            queue.push({ url: link, depth: item.depth + 1 });
          }
        }
      }
    } catch (error) {
      pages.push({
        url: normalizedUrl,
        status: "failed",
        depth: item.depth,
        error: "fetch_failed"
      });
    }

    if (queue.length && visited.size < crawlInput.maxPages) {
      await sleep(CRAWL_REQUEST_DELAY_MS);
    }
  }

  return {
    documents,
    pages
  };
}

function extractCrawlLinks(html, baseUrl, allowedHosts) {
  const links = [];
  const seenLinks = new Set();
  const matches = html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi);

  for (const match of matches) {
    if (links.length >= MAX_CRAWL_LINKS_PER_PAGE) {
      break;
    }

    const href = String(match[1] || "").trim();
    const normalizedUrl = normalizeDiscoveredUrl(href, baseUrl, allowedHosts);
    if (!normalizedUrl || seenLinks.has(normalizedUrl)) {
      continue;
    }

    seenLinks.add(normalizedUrl);
    links.push(normalizedUrl);
  }

  return links;
}

function normalizeDiscoveredUrl(href, baseUrl, allowedHosts) {
  if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) {
    return "";
  }

  try {
    const url = new URL(href, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }

    if (!allowedHosts.has(url.hostname.toLowerCase())) {
      return "";
    }

    if (/\.(png|jpe?g|gif|webp|svg|css|js|ico|zip|pdf)(\?|$)/i.test(url.pathname)) {
      return "";
    }

    return normalizeCrawlUrl(url.toString());
  } catch {
    return "";
  }
}

function normalizeCrawlUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function isHtmlDocument(document) {
  return document.contentType.includes("html") || /<a\b/i.test(document.rawText);
}

function extractLlmDocumentsFromSource(sourceInput) {
  const blocks = extractRelevantTextBlocks(sourceInput.sourceText);
  return blocks.map((block, index) => ({
    id: `${normalizeCode(sourceInput.sourcePlatform)}_${index + 1}`,
    sourceUrl: sourceInput.sourceUrl,
    sourcePlatform: sourceInput.sourcePlatform,
    text: block
  }));
}

function extractRelevantTextBlocks(text) {
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  LLM_SOURCE_KEYWORDS.lastIndex = 0;
  if (!normalizedText || !LLM_SOURCE_KEYWORDS.test(normalizedText)) {
    return [];
  }

  const blocks = [];
  const seenBlocks = new Set();
  LLM_SOURCE_KEYWORDS.lastIndex = 0;
  const matches = normalizedText.matchAll(LLM_SOURCE_KEYWORDS);

  for (const match of matches) {
    const index = match.index || 0;
    const start = Math.max(0, index - 500);
    const end = Math.min(normalizedText.length, index + 1300);
    const block = normalizedText.slice(start, end).trim();
    const key = block.slice(0, 160);

    if (block && !seenBlocks.has(key)) {
      seenBlocks.add(key);
      blocks.push(block);
    }

    if (blocks.length >= 8) {
      break;
    }
  }

  if (!blocks.length && normalizedText.length <= 1800) {
    return [normalizedText];
  }

  return blocks;
}

async function extractCandidatesWithLlm(documents) {
  if (!documents.length) {
    return [];
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ApiError(400, "llm_not_configured");
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "你是游戏兑换码信息抽取器。只从输入的公开帖子文本中抽取明确可用于兑换码工具的兑换码。不要抽取组队码、活动链接参数、URL 参数、用户 ID、日期、页码、图片 hash、帖子 ID。兑换码可以是 5 到 24 位且同时含字母与数字的英文数字组合，或被明确标注为兑换码/礼包码的中文口令。只返回 JSON。"
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                task:
                  "从 documents 中抽取心动小镇兑换码信息。只有当文本明确表达兑换码/礼包码含义，且 code 是英文数字码或明确标注的中文礼包码时才返回 item。无法确定奖励时 reward 填 奖励待确认；无法确定有效期时 expireAt 留空。",
                documents: documents.slice(0, 20)
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "gift_code_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: {
              items: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "code",
                    "title",
                    "reward",
                    "expireAt",
                    "confidence",
                    "evidence",
                    "sourceUrl",
                    "sourcePlatform"
                  ],
                  properties: {
                    code: { type: "string" },
                    title: { type: "string" },
                    reward: { type: "string" },
                    expireAt: { type: "string" },
                    confidence: { type: "string", enum: ["high", "medium", "low"] },
                    evidence: { type: "string" },
                    sourceUrl: { type: "string" },
                    sourcePlatform: { type: "string", enum: ["taptap", "xiaohongshu", "other"] }
                  }
                }
              }
            }
          }
        }
      }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status >= 500 ? 502 : 400, payload.error?.code || "llm_request_failed");
  }

  const text = extractResponseText(payload);
  const parsed = JSON.parse(text);
  return mergeLlmCandidates((parsed.items || []).map(normalizeLlmCandidate).filter(Boolean));
}

function extractResponseText(payload) {
  if (payload.output_text) {
    return payload.output_text;
  }

  const text = (payload.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || content.output_text || "")
    .join("");

  if (!text) {
    throw new ApiError(502, "llm_empty_response");
  }

  return text;
}

function normalizeLlmCandidate(item) {
  const code = normalizeSubmittedCode(item?.code);
  const evidence = String(item?.evidence || "").trim().replace(/\s+/g, " ").slice(0, 180);
  const sourceUrl = String(item?.sourceUrl || "").trim();
  const sourcePlatform = ["taptap", "xiaohongshu", "other"].includes(item?.sourcePlatform)
    ? item.sourcePlatform
    : inferSourcePlatform(sourceUrl);

  if (!isValidGiftCodeShape(code) || isRejectedCodeEvidence(code, evidence)) {
    return null;
  }

  const expireAt = String(item?.expireAt || "").trim();
  if (expireAt && !isValidDateOnly(expireAt)) {
    return null;
  }

  return {
    code,
    title: String(item?.title || "公开来源兑换码").trim().replace(/\s+/g, " ").slice(0, 40),
    reward: String(item?.reward || PENDING_REWARD_TEXT).trim().replace(/\s+/g, " ").slice(0, 80) || PENDING_REWARD_TEXT,
    expireAt,
    sourceUrl,
    sourcePlatform,
    note: evidence,
    confidence: item?.confidence === "high" ? "high" : item?.confidence === "medium" ? "medium" : "low"
  };
}

function isValidGiftCodeShape(code) {
  const isEnglishAlphanumeric = /^[A-Z0-9]{5,24}$/.test(code) && /[A-Z]/.test(code) && /\d/.test(code);
  const isChinesePhrase = /^[\u3400-\u9FFF]{2,20}$/.test(code);
  return isEnglishAlphanumeric || isChinesePhrase;
}

function isRejectedCodeEvidence(code, evidence) {
  if (!evidence) {
    return true;
  }

  const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[?&]code=${escapedCode}\\b`, "i").test(evidence) || /组队|teamup|邀请|加入/.test(evidence);
}

function mergeLlmCandidates(candidates) {
  const candidatesByCode = new Map();

  for (const candidate of candidates) {
    const key = normalizeCode(candidate.code);
    const existing = candidatesByCode.get(key);
    if (!existing) {
      candidatesByCode.set(key, candidate);
      continue;
    }

    const selected = getConfidenceRank(candidate.confidence) > getConfidenceRank(existing.confidence) ? candidate : existing;
    if (selected.reward === PENDING_REWARD_TEXT && candidate.reward !== PENDING_REWARD_TEXT) {
      selected.reward = candidate.reward;
    }
    if (!selected.expireAt && candidate.expireAt) {
      selected.expireAt = candidate.expireAt;
    }
    candidatesByCode.set(key, selected);
  }

  return [...candidatesByCode.values()];
}

function getConfidenceRank(confidence) {
  if (confidence === "high") {
    return 3;
  }

  if (confidence === "medium") {
    return 2;
  }

  return 1;
}

function withPageCandidateCounts(pages, candidates) {
  return pages.map((page) => ({
    ...page,
    candidateCount: candidates.filter((candidate) => candidate.sourceUrl === page.url).length
  }));
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, number));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withCandidateStatus(db, candidate) {
  return {
    ...candidate,
    duplicateStatus: getCandidateDuplicateStatus(db, candidate.code)
  };
}

function getCandidateDuplicateStatus(db, code) {
  if (findCode(db, normalizeCode(code))) {
    return "existing";
  }

  if (findPendingSubmission(db, code)) {
    return "pending";
  }

  return "new";
}

function normalizeFullWidth(value) {
  return value.replace(/[\uFF01-\uFF5E]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function inferSourcePlatform(sourceUrl) {
  if (!sourceUrl) {
    return "other";
  }

  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase();
    if (hostname === "taptap.cn" || hostname.endsWith(".taptap.cn")) {
      return "taptap";
    }

    if (
      hostname === "xiaohongshu.com" ||
      hostname.endsWith(".xiaohongshu.com") ||
      hostname === "xhslink.com" ||
      hostname.endsWith(".xhslink.com")
    ) {
      return "xiaohongshu";
    }
  } catch {
    return "other";
  }

  return "other";
}

function getShanghaiTodayParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(new Date());

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value)
  };
}

function toValidDateOnly(year, month, day) {
  const value = formatDateOnly(year, month, day);
  return isValidDateOnly(value) ? value : "";
}

function formatDateOnly(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function readBody(request) {
  let raw = "";

  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) {
      throw new ApiError(413, "request_body_too_large");
    }
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

function getClientId(body) {
  return String(body.clientId || "local-dev").slice(0, 80);
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

class ApiError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}
