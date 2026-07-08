const ADMIN_TABS = ["submissions", "rewardFeedback", "feedback"];

const adminState = {
  activeTab: getInitialTab(),
  updatedAt: "",
  submissions: [],
  rewardFeedback: [],
  feedback: []
};

const toast = document.querySelector("#toast");
const adminPanel = document.querySelector("#adminPanel");

initAdmin().catch(() => {
  showToast("后台加载失败，请确认本地服务已启动");
});

async function initAdmin() {
  bindAdminTabs();
  await refreshAdmin();
}

async function refreshAdmin() {
  const response = await fetch("/api/admin/overview", {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("failed to load admin overview");
  }

  const payload = await response.json();
  adminState.updatedAt = payload.updatedAt || "";
  adminState.submissions = payload.submissions || [];
  adminState.rewardFeedback = payload.rewardFeedback || [];
  adminState.feedback = payload.feedback || [];

  renderAdmin();
}

function bindAdminTabs() {
  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.adminTab;
      if (!ADMIN_TABS.includes(tab) || tab === adminState.activeTab) {
        return;
      }

      adminState.activeTab = tab;
      window.location.hash = tab;
      renderAdmin();
      adminPanel.focus({ preventScroll: true });
    });
  });
}

function renderAdmin() {
  document.querySelector("#adminUpdatedAt").textContent = `最近更新 ${formatDateTime(adminState.updatedAt)}`;

  renderCount("#submissionCount", adminState.submissions.length);
  renderCount("#rewardFeedbackCount", adminState.rewardFeedback.length);
  renderCount("#feedbackCount", adminState.feedback.length);
  renderTabs();
  renderActivePanel();
  bindAdminActions();
}

function renderCount(selector, count) {
  document.querySelector(selector).textContent = String(count);
}

function renderTabs() {
  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    const isActive = button.dataset.adminTab === adminState.activeTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });
}

function renderActivePanel() {
  if (adminState.activeTab === "rewardFeedback") {
    renderRewardFeedbackPanel();
    return;
  }

  if (adminState.activeTab === "feedback") {
    renderFeedbackPanel();
    return;
  }

  renderSubmissionPanel();
}

function renderSubmissionPanel() {
  adminPanel.innerHTML = `
    <section class="admin-page" aria-label="新兑换码审核">
      ${renderPanelHeader("新兑换码", "审核玩家提交的新兑换码，通过后会进入前台兑换码列表。")}
      <div class="admin-table-wrap">
        <table class="admin-table is-submissions">
          <colgroup>
            <col class="col-status" />
            <col class="col-code" />
            <col class="col-title" />
            <col class="col-reward" />
            <col class="col-expire" />
            <col class="col-source" />
            <col class="col-created" />
            <col class="col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>状态</th>
              <th>兑换码</th>
              <th>名称</th>
              <th>奖励</th>
              <th>有效期</th>
              <th>来源</th>
              <th>提交时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(adminState.submissions, renderSubmissionRow, 8)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderRewardFeedbackPanel() {
  adminPanel.innerHTML = `
    <section class="admin-page" aria-label="奖励补充审核">
      ${renderPanelHeader("奖励补充", "审核玩家补充的奖励内容，通过后才会更新前台奖励展示。")}
      <div class="admin-table-wrap">
        <table class="admin-table is-reward-feedback">
          <colgroup>
            <col class="col-status" />
            <col class="col-code" />
            <col class="col-reward" />
            <col class="col-created" />
            <col class="col-reviewed" />
            <col class="col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>状态</th>
              <th>兑换码</th>
              <th>奖励内容</th>
              <th>提交时间</th>
              <th>审核时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(adminState.rewardFeedback, renderRewardFeedbackRow, 6)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderFeedbackPanel() {
  adminPanel.innerHTML = `
    <section class="admin-page" aria-label="使用结果">
      ${renderPanelHeader("使用结果", "玩家提交的兑换结果只用于观察和失效判断，不进入审核流。")}
      <div class="admin-table-wrap">
        <table class="admin-table is-feedback">
          <colgroup>
            <col class="col-code" />
            <col class="col-result" />
            <col class="col-created" />
          </colgroup>
          <thead>
            <tr>
              <th>兑换码</th>
              <th>结果</th>
              <th>反馈时间</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(adminState.feedback, renderFeedbackRow, 3)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderPanelHeader(title, description) {
  return `
    <div class="admin-panel-header">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
    </div>
  `;
}

function renderRows(items, renderer, colspan) {
  if (!items.length) {
    return `<tr><td class="admin-empty-cell" colspan="${colspan}">暂无数据</td></tr>`;
  }

  return items.map(renderer).join("");
}

function renderSubmissionRow(item) {
  return `
    <tr>
      <td>${renderStatus(item.reviewStatus)}</td>
      <td><span class="admin-code">${escapeHtml(item.code)}</span></td>
      <td>${escapeHtml(item.title || "未填写名称")}</td>
      <td>${escapeHtml(item.reward || "未填写奖励")}</td>
      <td>${escapeHtml(formatDate(item.expireAt))}</td>
      <td>${renderSource(item.sourceUrl)}</td>
      <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
      <td>${renderReviewActions("submission", item.id, item.reviewStatus)}</td>
    </tr>
  `;
}

function renderRewardFeedbackRow(item) {
  return `
    <tr>
      <td>${renderStatus(item.reviewStatus)}</td>
      <td><span class="admin-code">${escapeHtml(item.code)}</span></td>
      <td>${escapeHtml(item.reward)}</td>
      <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
      <td>${escapeHtml(item.reviewedAt ? formatDateTime(item.reviewedAt) : "-")}</td>
      <td>${renderReviewActions("reward", item.id, item.reviewStatus)}</td>
    </tr>
  `;
}

function renderFeedbackRow(item) {
  const result = item.result === "valid" ? "可用" : "失效";
  const resultClass = item.result === "valid" ? "is-approved" : "is-rejected";

  return `
    <tr>
      <td><span class="admin-code">${escapeHtml(item.code)}</span></td>
      <td><span class="admin-status ${resultClass}">${escapeHtml(result)}</span></td>
      <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
    </tr>
  `;
}

function renderStatus(status) {
  return `<span class="admin-status ${escapeAttr(getStatusClass(status))}">${escapeHtml(formatStatus(status))}</span>`;
}

function formatStatus(status) {
  if (status === "approved") {
    return "已通过";
  }

  if (status === "rejected") {
    return "已拒绝";
  }

  return "待审核";
}

function getStatusClass(status) {
  if (status === "approved") {
    return "is-approved";
  }

  if (status === "rejected") {
    return "is-rejected";
  }

  return "is-pending";
}

function renderReviewActions(type, id, status) {
  if (status !== "pending" || !id) {
    return '<span class="admin-action-placeholder">-</span>';
  }

  return `
    <div class="admin-actions">
      <button class="admin-action-button" type="button" data-review-type="${escapeAttr(type)}" data-review-id="${escapeAttr(id)}" data-review-decision="approved">通过</button>
      <button class="admin-action-button danger" type="button" data-review-type="${escapeAttr(type)}" data-review-id="${escapeAttr(id)}" data-review-decision="rejected">拒绝</button>
    </div>
  `;
}

function renderSource(sourceUrl) {
  const value = String(sourceUrl || "").trim();
  if (!value) {
    return "-";
  }

  if (!isHttpUrl(value)) {
    return escapeHtml(value);
  }

  return `
    <a class="admin-source-link" href="${escapeAttr(value)}" title="${escapeAttr(value)}" target="_blank" rel="noreferrer noopener">
      ${escapeHtml(value)}
    </a>
  `;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function bindAdminActions() {
  document.querySelectorAll("[data-review-type]").forEach((button) => {
    button.addEventListener("click", () => {
      submitReview(button.dataset.reviewType, button.dataset.reviewId, button.dataset.reviewDecision);
    });
  });
}

async function submitReview(type, id, decision) {
  const endpoint =
    type === "submission"
      ? `/api/admin/submissions/${encodeURIComponent(id)}/review`
      : `/api/admin/reward-feedback/${encodeURIComponent(id)}/review`;

  try {
    await postJson(endpoint, { decision });
    showToast(decision === "approved" ? "已通过" : "已拒绝");
    await refreshAdmin();
  } catch (error) {
    showToast(getReviewErrorMessage(error.message));
  }
}

function getReviewErrorMessage(error) {
  if (error === "code_already_exists") {
    return "兑换码已存在，不能通过";
  }

  if (error.endsWith("_already_reviewed")) {
    return "这条内容已经审核过";
  }

  return "审核失败，请稍后再试";
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
    throw new Error(payload.error || "request_failed");
  }

  return response.json();
}

function getInitialTab() {
  const tab = window.location.hash.replace("#", "");
  return ADMIN_TABS.includes(tab) ? tab : "submissions";
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
  const date = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) {
    return "待确认";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
