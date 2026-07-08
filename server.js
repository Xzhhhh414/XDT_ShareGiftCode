const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4173);
const ROOT_DIR = __dirname;
const SERVER_DIR = path.join(ROOT_DIR, "server");
const DB_PATH = path.join(SERVER_DIR, "db.json");
const SEED_PATH = path.join(SERVER_DIR, "db.seed.json");
const MAX_BODY_BYTES = 4096;
let dbMutationQueue = Promise.resolve();

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

server.listen(PORT, () => {
  console.log(`XDT Share Gift Code running at http://localhost:${PORT}`);
});

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/gift-codes") {
    const db = await readDb();
    sendJson(response, 200, toClientPayload(db));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/overview") {
    const db = await readDb();
    sendJson(response, 200, toAdminPayload(db));
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
  const code = normalizeCode(rawCode);
  const result = String(body.result || "").trim();

  if (!["valid", "invalid"].includes(result)) {
    sendJson(response, 400, { error: "invalid_result" });
    return;
  }

  const payload = await mutateDb(async (db) => {
    if (!findCode(db, code)) {
      throw new ApiError(404, "code_not_found");
    }

    const feedback = {
      code,
      result,
      createdAt: new Date().toISOString(),
      clientId: getClientId(body)
    };

    db.feedback = [...(db.feedback || []), feedback];
    db.updatedAt = feedback.createdAt;

    return {
      latestFeedback: toClientFeedback(feedback),
      updatedAt: db.updatedAt
    };
  });

  sendJson(response, 201, payload);
}

async function createRewardFeedback(response, rawCode, body) {
  const code = normalizeCode(rawCode);
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
          status: "active",
          reward: submission.reward,
          expireAt: `${submission.expireAt}T23:59:59+08:00`,
          sourcePlatform: "player",
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
  return (
    requestPath === "/index.html" ||
    requestPath === "/admin.html" ||
    requestPath === "/styles.css" ||
    requestPath === "/script.js" ||
    requestPath === "/admin.js" ||
    requestPath.startsWith("/data/") ||
    requestPath.startsWith("/assets/")
  );
}

async function readDb() {
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
  await fs.writeFile(DB_PATH, `${JSON.stringify(db, null, 2)}\n`);
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

function normalizeCode(code) {
  return String(code || "").trim().toLowerCase();
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
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

class ApiError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}
