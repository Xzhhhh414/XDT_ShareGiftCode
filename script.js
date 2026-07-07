const state = {
  codes: [],
  feedback: readJson("xdt-gift-code-feedback", {})
};

const codeList = document.querySelector("#codeList");
const emptyState = document.querySelector("#emptyState");
const toast = document.querySelector("#toast");
const feedbackModal = document.querySelector("#feedbackModal");

let activeFeedbackItem = null;

function init() {
  state.codes = normalizeCodes(window.GIFT_CODE_DATA?.codes || []);
  bindFeedbackModal();
  renderUpdatedAt();
  renderList();
}

function normalizeCodes(codes) {
  return codes
    .map((item) => ({
      ...item,
      feedbackKey: item.code.toLowerCase(),
      computedStatus: computeStatus(item)
    }))
    .sort(sortCodes);
}

function computeStatus(item) {
  if (isExpired(item)) {
    return "expired";
  }

  if (item.status === "active" || item.status === "expiring") {
    return "active";
  }

  return "unknown";
}

function isExpired(item) {
  if (item.status === "expired" || item.visible === false) {
    return true;
  }

  const expireAt = parseDate(item.expireAt);
  const latestFeedback = getLatestFeedback(item);
  if (!expireAt && latestFeedback?.result === "invalid" && isOlderThanHours(latestFeedback.at, 12)) {
    return true;
  }

  if (!expireAt) {
    return false;
  }

  return expireAt.getTime() < Date.now();
}

function sortCodes(a, b) {
  return getPublishedTime(b) - getPublishedTime(a);
}

function getPublishedTime(item) {
  const date = new Date(item.firstSeenAt || item.lastSeenAt || 0);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}

function renderUpdatedAt() {
  document.querySelector("#updatedAt").textContent = `最近更新 ${formatDateTime(window.GIFT_CODE_DATA?.updatedAt)}`;
}

function renderList() {
  const visibleCodes = getVisibleCodes();

  codeList.innerHTML = "";
  emptyState.hidden = visibleCodes.length > 0;

  visibleCodes.forEach((item) => {
    codeList.append(createCodeCard(item));
  });
}

function getVisibleCodes() {
  return getDisplayableCodes();
}

function getDisplayableCodes() {
  return state.codes.filter((item) => item.computedStatus !== "expired");
}

function createCodeCard(item) {
  const hasExplicitExpire = Boolean(parseDate(item.expireAt));
  const latestFeedback = getLatestFeedback(item);
  const feedbackActions =
    item.computedStatus === "unknown"
      ? `
        <div class="feedback-prompt">
          <button class="feedback-open-button" type="button" data-action="open-feedback">欢迎分享使用结果</button>
        </div>
      `
      : "";
  const card = document.createElement("article");
  card.className = "code-card";
  card.dataset.code = item.code;

  card.innerHTML = `
    <div class="code-main">
      <h2 class="card-title">${escapeHtml(getCardTitle(item, hasExplicitExpire, latestFeedback))}</h2>
      <div class="code-title-row">
        <span class="code-text">${escapeHtml(item.code)}</span>
        <button class="icon-text-button primary copy-button" type="button" data-action="copy">
          <span aria-hidden="true">⧉</span>
          <span>复制</span>
        </button>
      </div>
      <p class="reward-text">${escapeHtml(item.reward || "奖励待确认")}</p>
      <div class="code-meta-row">
        <span>${formatValidityLine(item, hasExplicitExpire, latestFeedback)}</span>
      </div>
    </div>
    ${feedbackActions ? `<div class="code-actions">${feedbackActions}</div>` : ""}
  `;

  card.querySelector('[data-action="copy"]').addEventListener("click", (event) => copyCode(event, item));
  card.querySelector('[data-action="open-feedback"]')?.addEventListener("click", () => openFeedbackModal(item));

  return card;
}

function bindFeedbackModal() {
  feedbackModal?.addEventListener("click", (event) => {
    if (event.target === feedbackModal || event.target.closest('[data-action="close-feedback"]')) {
      closeFeedbackModal();
    }
  });

  feedbackModal?.querySelectorAll("[data-feedback-result]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!activeFeedbackItem) {
        return;
      }

      voteCode(activeFeedbackItem, button.dataset.feedbackResult);
      closeFeedbackModal();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !feedbackModal?.hidden) {
      closeFeedbackModal();
    }
  });
}

function openFeedbackModal(item) {
  activeFeedbackItem = item;
  feedbackModal.hidden = false;
  document.body.classList.add("modal-open");
  feedbackModal.querySelector("[data-feedback-result]")?.focus();
}

function closeFeedbackModal() {
  feedbackModal.hidden = true;
  document.body.classList.remove("modal-open");
  activeFeedbackItem = null;
}

async function copyCode(event, item) {
  const button = event.currentTarget;

  try {
    await writeClipboard(item.code);
    button.classList.add("is-copied");
    button.querySelector("span:last-child").textContent = "已复制";
    showToast(`已复制 ${item.code}`);
    setTimeout(() => {
      button.classList.remove("is-copied");
      button.querySelector("span:last-child").textContent = "复制";
    }, 1600);
  } catch {
    showToast("复制失败，可以手动选中兑换码复制");
  }
}

function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const ok = document.execCommand("copy");
  input.remove();

  return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
}

function voteCode(item, vote) {
  state.feedback[item.feedbackKey] = {
    result: vote,
    votedAt: new Date().toISOString()
  };
  writeJson("xdt-gift-code-feedback", state.feedback);
  showToast(vote === "valid" ? "已记录可用反馈" : "已记录失效反馈");
  item.computedStatus = computeStatus(item);
  renderList();
}

function formatExpire(expireAt) {
  if (!expireAt) {
    return "有效期不确定";
  }

  const date = parseDate(expireAt);
  if (!date) {
    return "有效期不确定";
  }

  const parts = getShanghaiParts(date);
  const nowParts = getShanghaiParts(new Date());
  const sameDay =
    parts.year === nowParts.year &&
    parts.month === nowParts.month &&
    parts.day === nowParts.day;
  const endOfDay = parts.hour === 23 && parts.minute >= 59;

  if (sameDay && endOfDay) {
    return "今日 24:00 前";
  }

  if (endOfDay) {
    return `${parts.month}月${parts.day}日 24:00 前`;
  }

  return `${parts.month}月${parts.day}日 ${padTime(parts.hour)}:${padTime(parts.minute)} 前`;
}

function getCardTitle(item, hasExplicitExpire, latestFeedback) {
  const explicitTitle = String(item.title || "").trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const reward = String(item.reward || "").trim();
  if (reward && reward !== "奖励待确认") {
    return `${reward.replace(/[、，,]/g, "")}兑换码`;
  }

  if (hasExplicitExpire) {
    return "限时礼包兑换码";
  }

  if (latestFeedback?.result === "valid") {
    return "玩家验证可用兑换码";
  }

  if (latestFeedback?.result === "invalid") {
    return "玩家反馈待确认兑换码";
  }

  return "待验证礼包兑换码";
}

function formatValidityLine(item, hasExplicitExpire, latestFeedback) {
  if (hasExplicitExpire) {
    return `有效期：${formatExpire(item.expireAt)}`;
  }

  if (!latestFeedback) {
    return "缺失明确有效期，等待玩家验证";
  }

  return `缺失明确有效期，${formatFeedbackResult(latestFeedback)}`;
}

function getLatestFeedback(item) {
  const remoteFeedback = normalizeFeedback(item.latestFeedback);
  const localFeedback = normalizeFeedback(state.feedback[item.feedbackKey]);

  if (!remoteFeedback) {
    return localFeedback;
  }

  if (!localFeedback) {
    return remoteFeedback;
  }

  return new Date(localFeedback.at).getTime() >= new Date(remoteFeedback.at).getTime()
    ? localFeedback
    : remoteFeedback;
}

function normalizeFeedback(feedback) {
  if (!feedback) {
    return null;
  }

  const result = feedback.result || feedback.vote;
  const at = feedback.at || feedback.votedAt;
  const date = new Date(at);

  if (!["valid", "invalid"].includes(result) || Number.isNaN(date.getTime())) {
    return null;
  }

  return { result, at };
}

function formatFeedbackResult(feedback) {
  const time = formatDateTime(feedback.at);

  if (feedback.result === "valid") {
    return `${time} 玩家兑换成功`;
  }

  return `${time} 玩家兑换失败，已失效`;
}

function isOlderThanHours(value, hours) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return Date.now() - date.getTime() >= hours * 60 * 60 * 1000;
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "待确认";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function getShanghaiParts(date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23"
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function padTime(value) {
  return String(value).padStart(2, "0");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value || "#");
}

init();
