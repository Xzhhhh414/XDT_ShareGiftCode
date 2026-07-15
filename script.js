const state = {
  codes: [],
  updatedAt: "",
  usesServer: false,
  clientId: getClientId(),
  feedback: readJson("xdt-gift-code-feedback", {}),
  rewardFeedback: readJson("xdt-gift-code-reward-feedback", {})
};

const codeList = document.querySelector("#codeList");
const emptyState = document.querySelector("#emptyState");
const toast = document.querySelector("#toast");
const feedbackModal = document.querySelector("#feedbackModal");
const submissionModal = document.querySelector("#submissionModal");
const submissionForm = document.querySelector("#submissionForm");
const submissionTitleInput = document.querySelector("#submissionTitleInput");
const submissionCodeInput = document.querySelector("#submissionCodeInput");
const submissionRewardInput = document.querySelector("#submissionRewardInput");
const submissionExpireInput = document.querySelector("#submissionExpireInput");
const submissionSourceInput = document.querySelector("#submissionSourceInput");
const rewardModal = document.querySelector("#rewardModal");
const rewardForm = document.querySelector("#rewardForm");
const rewardInput = document.querySelector("#rewardInput");
const apiBaseUrl = normalizeApiBaseUrl(window.XDT_GIFT_CODE_CONFIG?.apiBaseUrl);

let activeFeedbackItem = null;
let activeRewardItem = null;

async function init() {
  bindFeedbackModal();
  bindSubmissionModal();
  bindRewardModal();
  await loadCodes();
  renderUpdatedAt();
  renderList();
}

async function loadCodes() {
  try {
    const response = await fetch(apiUrl("/gift-codes"), {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("failed to load gift codes");
    }

    const payload = await response.json();
    state.usesServer = true;
    state.updatedAt = payload.updatedAt || "";
    state.codes = normalizeCodes(payload.codes || []);
  } catch {
    state.usesServer = false;
    if (apiBaseUrl) {
      state.updatedAt = "";
      state.codes = [];
      emptyState.querySelector("p").textContent = "兑换码暂时无法加载，请稍后重试";
      return;
    }
    state.updatedAt = window.GIFT_CODE_DATA?.updatedAt || "";
    state.codes = normalizeCodes(window.GIFT_CODE_DATA?.codes || []);
  }
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
  document.querySelector("#updatedAt").textContent = `最近更新 ${formatDateTime(state.updatedAt)}`;
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
  const rewardText = getRewardText(item);
  const actionButtons = [
    needsRewardFeedback(item)
      ? '<button class="feedback-open-button" type="button" data-action="open-reward">分享奖励内容</button>'
      : "",
    item.computedStatus === "unknown"
      ? '<button class="feedback-open-button" type="button" data-action="open-feedback">分享使用结果</button>'
      : ""
  ].filter(Boolean);
  const actionClass = actionButtons.length > 1 ? "feedback-prompt is-split" : "feedback-prompt";
  const actions = actionButtons.length ? `<div class="${actionClass}">${actionButtons.join("")}</div>` : "";
  const card = document.createElement("article");
  card.className = "code-card";
  card.dataset.code = item.code;

  card.innerHTML = `
    <div class="code-main">
      <div class="card-header">
        <h2 class="card-title">${escapeHtml(getCardTitle(item, hasExplicitExpire, latestFeedback))}</h2>
        <span class="publish-badge">${escapeHtml(formatPublishedAt(item))}</span>
      </div>
      <div class="code-title-row">
        <span class="code-text">${escapeHtml(item.code)}</span>
        <button class="icon-text-button primary copy-button" type="button" data-action="copy">
          <span aria-hidden="true">⧉</span>
          <span>复制</span>
        </button>
      </div>
      <p class="reward-text">${escapeHtml(rewardText)}</p>
      <div class="code-meta-row">
        <span>${formatValidityLine(item, hasExplicitExpire, latestFeedback)}</span>
      </div>
    </div>
    ${actions ? `<div class="code-actions">${actions}</div>` : ""}
  `;

  card.querySelector('[data-action="copy"]').addEventListener("click", (event) => copyCode(event, item));
  card.querySelector('[data-action="open-feedback"]')?.addEventListener("click", () => openFeedbackModal(item));
  card.querySelector('[data-action="open-reward"]')?.addEventListener("click", () => openRewardModal(item));

  return card;
}

function bindSubmissionModal() {
  document.querySelector('[data-action="open-submission"]')?.addEventListener("click", openSubmissionModal);

  submissionModal?.addEventListener("click", (event) => {
    if (event.target === submissionModal || event.target.closest('[data-action="close-submission"]')) {
      closeSubmissionModal();
    }
  });

  submissionForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitCodeSubmission();
  });

  submissionExpireInput?.addEventListener("click", openSubmissionExpirePicker);
  submissionExpireInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSubmissionExpirePicker();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !submissionModal?.hidden) {
      closeSubmissionModal();
    }
  });
}

function openSubmissionExpirePicker() {
  submissionExpireInput.focus({ preventScroll: true });

  if (typeof submissionExpireInput.showPicker !== "function") {
    return;
  }

  try {
    submissionExpireInput.showPicker();
  } catch {
    // Some browsers throw when the native picker is already open.
  }
}

function openSubmissionModal() {
  if (!state.usesServer) {
    showToast("需要启动本地服务后才能提交兑换码");
    return;
  }

  submissionModal.hidden = false;
  document.body.classList.add("modal-open");
  submissionCodeInput.focus();
}

function closeSubmissionModal() {
  submissionModal.hidden = true;
  document.body.classList.remove("modal-open");
  submissionForm?.reset();
}

async function submitCodeSubmission() {
  const title = submissionTitleInput.value.trim();
  const code = submissionCodeInput.value.trim().replace(/\s+/g, "");
  const reward = submissionRewardInput.value.trim();
  const expireAt = submissionExpireInput.value;
  const sourceUrl = submissionSourceInput.value.trim();

  if (!title) {
    showToast("请填写名称");
    submissionTitleInput.focus();
    return;
  }

  if (!code) {
    showToast("请填写兑换码");
    submissionCodeInput.focus();
    return;
  }

  if (!reward) {
    showToast("请填写奖励");
    submissionRewardInput.focus();
    return;
  }

  if (!expireAt) {
    showToast("请填写有效期");
    submissionExpireInput.focus();
    return;
  }

  try {
    await postJson(apiUrl("/submissions"), {
      title,
      code,
      reward,
      expireAt,
      sourceUrl,
      clientId: state.clientId
    });
    showToast("已提交，等待审核");
    closeSubmissionModal();
  } catch (error) {
    if (error.message === "code_already_exists") {
      showToast("这个兑换码已经存在");
      submissionCodeInput.focus();
      return;
    }

    if (error.message === "submission_already_exists") {
      showToast("这个兑换码已经有人提交，等待审核中");
      submissionCodeInput.focus();
      return;
    }

    showToast("提交失败，请稍后再试");
  }
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

function bindRewardModal() {
  rewardModal?.addEventListener("click", (event) => {
    if (event.target === rewardModal || event.target.closest('[data-action="close-reward"]')) {
      closeRewardModal();
    }
  });

  rewardForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRewardFeedback();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !rewardModal?.hidden) {
      closeRewardModal();
    }
  });
}

function openRewardModal(item) {
  activeRewardItem = item;
  rewardInput.value = getLocalRewardFeedback(item)?.reward || "";
  rewardModal.hidden = false;
  document.body.classList.add("modal-open");
  rewardInput.focus();
}

function closeRewardModal() {
  rewardModal.hidden = true;
  document.body.classList.remove("modal-open");
  activeRewardItem = null;
  rewardForm?.reset();
}

async function submitRewardFeedback() {
  if (!activeRewardItem) {
    return;
  }

  const reward = rewardInput.value.trim().replace(/\s+/g, " ");
  if (!reward) {
    showToast("请填写奖励内容");
    rewardInput.focus();
    return;
  }

  if (state.usesServer) {
    try {
      const payload = await postJson(apiUrl(`/gift-codes/${encodeURIComponent(activeRewardItem.code)}/reward-feedback`), {
        reward,
        clientId: state.clientId
      });
      state.updatedAt = payload.updatedAt || state.updatedAt;
      showToast("已提交奖励内容，等待审核");
      closeRewardModal();
      renderUpdatedAt();
      renderList();
    } catch {
      showToast("提交失败，请稍后再试");
      rewardInput.focus();
    }

    return;
  }

  state.rewardFeedback[activeRewardItem.feedbackKey] = {
    reward,
    submittedAt: new Date().toISOString()
  };
  writeJson("xdt-gift-code-reward-feedback", state.rewardFeedback);
  showToast("已记录奖励内容");
  closeRewardModal();
  renderList();
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

async function voteCode(item, vote) {
  if (state.usesServer) {
    try {
      const payload = await postJson(apiUrl(`/gift-codes/${encodeURIComponent(item.code)}/feedback`), {
        result: vote,
        clientId: state.clientId
      });
      item.latestFeedback = payload.latestFeedback;
      item.visible = payload.visible !== false;
      state.updatedAt = payload.updatedAt || state.updatedAt;
      item.computedStatus = computeStatus(item);
      showToast(vote === "valid" ? "已提交可用反馈" : "已提交失效反馈，礼包码已下架");
      renderUpdatedAt();
      renderList();
    } catch {
      showToast("提交失败，请稍后再试");
    }

    return;
  }

  state.feedback[item.feedbackKey] = {
    result: vote,
    votedAt: new Date().toISOString()
  };
  writeJson("xdt-gift-code-feedback", state.feedback);
  if (vote === "invalid" && !parseDate(item.expireAt)) {
    item.visible = false;
  }
  showToast(vote === "valid" ? "已记录可用反馈" : "已记录失效反馈，礼包码已下架");
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

  const reward = getRewardText(item);
  if (!isPendingReward(reward)) {
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

function formatPublishedAt(item) {
  const publishedAt = item.firstSeenAt || item.lastSeenAt;
  return `发布日期 ${formatMonthDay(publishedAt)}`;
}

function getRewardText(item) {
  return (!state.usesServer ? getLocalRewardFeedback(item)?.reward : "") || item.reward || "奖励待确认";
}

function getLocalRewardFeedback(item) {
  return normalizeRewardFeedback(state.rewardFeedback[item.feedbackKey]);
}

function normalizeRewardFeedback(feedback) {
  if (!feedback) {
    return null;
  }

  const reward = String(feedback.reward || "").trim();
  if (!reward) {
    return null;
  }

  return {
    reward,
    submittedAt: feedback.submittedAt || feedback.at || ""
  };
}

function needsRewardFeedback(item) {
  return isPendingReward(item.sourceReward ?? item.reward);
}

function isPendingReward(value) {
  const reward = String(value || "").trim();
  return !reward || reward === "奖励待确认" || reward === "待确认" || reward === "来源未明确";
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
  if (state.usesServer) {
    return remoteFeedback;
  }

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

function formatMonthDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "待确认";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit"
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

function normalizeApiBaseUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "http:" ? normalized : "";
  } catch {
    return "";
  }
}

function apiUrl(pathname) {
  return apiBaseUrl ? `${apiBaseUrl}/api${pathname}` : `/api${pathname}`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "request failed");
  }

  return response.json();
}

function getClientId() {
  const key = "xdt-gift-code-client-id";
  const clientId =
    window.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const existing = localStorage.getItem(key);
    if (existing) {
      return existing;
    }

    localStorage.setItem(key, clientId);
  } catch {
    return clientId;
  }

  return clientId;
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

init().catch(() => {
  showToast("页面初始化失败，请刷新重试");
});
