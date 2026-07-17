const ADMIN_TABS = ["sourceParser", "codes", "submissions", "rewardFeedback", "feedback"];

const adminState = {
  activeTab: getInitialTab(),
  role: "admin",
  updatedAt: "",
  codes: [],
  submissions: [],
  rewardFeedback: [],
  feedback: [],
  sourceDraft: {
    importFile: null,
    importFileName: "",
    candidates: [],
    parsed: false
  }
};

const toast = document.querySelector("#toast");
const adminPanel = document.querySelector("#adminPanel");

initAdmin().catch(() => {
  showToast("后台加载失败，请确认本地服务已启动");
});

async function initAdmin() {
  bindAdminTabs();
  await ensureAdminSession();
  await refreshAdmin();
}

async function ensureAdminSession() {
  const response = await fetch("/api/admin/session", { headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!payload.authenticated) {
    window.location.replace("/login.html");
    throw new Error("admin_auth_required");
  }

  adminState.role = payload.role === "player_admin" ? "player_admin" : "admin";
  ensureAllowedActiveTab();
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
  adminState.role = payload.role === "player_admin" ? "player_admin" : adminState.role;
  adminState.codes = payload.codes || [];
  adminState.submissions = payload.submissions || [];
  adminState.rewardFeedback = payload.rewardFeedback || [];
  adminState.feedback = payload.feedback || [];

  renderAdmin();
}

function bindAdminTabs() {
  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.adminTab;
      if (!getAllowedTabs().includes(tab) || tab === adminState.activeTab) {
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
  ensureAllowedActiveTab();
  document.querySelector("#adminUpdatedAt").textContent = `最近更新 ${formatDateTime(adminState.updatedAt)}`;

  renderCount("#sourceCandidateCount", adminState.sourceDraft.candidates.length);
  renderCount("#codeCount", adminState.codes.length);
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
    const allowed = getAllowedTabs().includes(button.dataset.adminTab);
    const isActive = button.dataset.adminTab === adminState.activeTab;
    button.hidden = !allowed;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-current", allowed && isActive ? "page" : "false");
  });
}

function getAllowedTabs() {
  return adminState.role === "player_admin" ? ["codes"] : ADMIN_TABS;
}

function ensureAllowedActiveTab() {
  if (!getAllowedTabs().includes(adminState.activeTab)) {
    adminState.activeTab = "codes";
    window.location.hash = "codes";
  }
}

function renderActivePanel() {
  if (adminState.activeTab === "sourceParser") {
    renderSourceParserPanel();
    return;
  }

  if (adminState.activeTab === "codes") {
    renderCodeManagementPanel();
    return;
  }

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

function renderSourceParserPanel() {
  adminPanel.innerHTML = `
    <section class="admin-page" aria-label="采集导入">
      ${renderPanelHeader("采集导入", "在本机运行 Codex 采集 skill，生成候选 JSON 后在此直接导入上架。")}
      <form class="source-parser-form" id="sourceImportForm">
        <label class="field-label" for="sourceImportInput">候选文件</label>
        <input class="field-input import-file-input" id="sourceImportInput" name="sourceImport" type="file" accept="application/json,.json" required />
        <p class="import-file-name">${adminState.sourceDraft.importFileName ? `已选择：${escapeHtml(adminState.sourceDraft.importFileName)}` : "只接受 Codex skill 生成的 JSON 文件。"}</p>
        <div class="source-actions">
          <button class="admin-action-button source-primary-action" type="submit">读取候选</button>
          <button class="admin-action-button" type="button" data-source-action="publish" ${getNewSourceCandidates().length ? "" : "disabled"}>直接上架</button>
        </div>
      </form>
      ${renderSourceCandidateTable()}
    </section>
  `;
}

function renderCodeManagementPanel() {
  const canDelete = adminState.role === "admin";
  adminPanel.innerHTML = `
    <section class="admin-page" aria-label="兑换码管理">
      ${renderPanelHeader("兑换码管理", canDelete ? "待确认信息会优先显示；支持手动下架、恢复和永久删除。" : "待确认信息会优先显示；支持手动下架和恢复。")}
      <div class="admin-table-wrap">
        <table class="admin-table is-codes">
          <colgroup>
            <col class="col-status" />
            <col class="col-code" />
            <col class="col-title" />
            <col class="col-reward" />
            <col class="col-expire" />
            <col class="col-source" />
            <col class="col-updated" />
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
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(adminState.codes, renderCodeRow, 8)}
          </tbody>
        </table>
      </div>
    </section>
  `;
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

function renderCrawlPageSummary() {
  const pages = adminState.sourceDraft.crawlPages || [];
  if (!pages.length) {
    return "";
  }

  return `
    <div class="crawl-summary">
      <h3>爬取结果</h3>
      <div class="crawl-page-list">
        ${pages.map(renderCrawlPageItem).join("")}
      </div>
    </div>
  `;
}

function renderCrawlPageItem(page) {
  const isFetched = page.status === "fetched";
  const statusText = isFetched ? `已抓取，候选 ${page.candidateCount || 0}` : "抓取失败";
  const statusClass = isFetched ? "is-approved" : "is-rejected";

  return `
    <div class="crawl-page-item">
      <span class="admin-status ${statusClass}">${escapeHtml(statusText)}</span>
      <a class="admin-source-link" href="${escapeAttr(page.url)}" title="${escapeAttr(page.url)}" target="_blank" rel="noreferrer noopener">
        ${escapeHtml(page.url)}
      </a>
    </div>
  `;
}

function renderSourceCandidateTable() {
  if (!adminState.sourceDraft.parsed) {
    return '<div class="source-empty-state">请选择 Codex skill 生成的候选文件</div>';
  }

  return `
    <div class="admin-table-wrap source-candidate-wrap">
      <table class="admin-table is-source-candidates">
        <colgroup>
          <col class="col-status" />
          <col class="col-code" />
          <col class="col-title" />
          <col class="col-reward" />
          <col class="col-expire" />
          <col class="col-confidence" />
        </colgroup>
        <thead>
          <tr>
            <th>状态</th>
            <th>兑换码</th>
            <th>名称</th>
            <th>奖励</th>
            <th>有效期</th>
            <th>置信度</th>
          </tr>
        </thead>
        <tbody>
          ${renderRows(adminState.sourceDraft.candidates, renderSourceCandidateRow, 6)}
        </tbody>
      </table>
    </div>
  `;
}

function renderSourceCandidateRow(item) {
  return `
    <tr>
      <td>${renderCandidateDuplicateStatus(item.duplicateStatus)}</td>
      <td><span class="admin-code">${escapeHtml(item.code)}</span></td>
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.reward || "奖励待确认")}</td>
      <td>${escapeHtml(formatDate(item.expireAt))}</td>
      <td>${escapeHtml(formatConfidence(item.confidence))}</td>
    </tr>
  `;
}

function renderCandidateDuplicateStatus(status) {
  const className = status === "new" ? "is-approved" : status === "existing" ? "is-rejected" : "is-pending";
  return `<span class="admin-status ${className}">${escapeHtml(formatDuplicateStatus(status))}</span>`;
}

function formatDuplicateStatus(status) {
  if (status === "existing") {
    return "已上架";
  }

  if (status === "pending") {
    return "审核中";
  }

  return "新候选";
}

function renderCodeRow(item) {
  return `
    <tr>
      <td>${renderCodeVisibility(item)}</td>
      <td><span class="admin-code">${escapeHtml(item.code)}</span></td>
      <td>${escapeHtml(item.title || "未填写名称")}</td>
      <td>${escapeHtml(item.reward || "奖励待确认")}</td>
      <td>${escapeHtml(formatCodeExpire(item.expireAt))}</td>
      <td>${renderSource(item.sourceUrl)}</td>
      <td>${escapeHtml(formatDateTime(item.updatedAt || item.firstSeenAt))}</td>
      <td>${renderCodeActions(item)}</td>
    </tr>
  `;
}

function renderCodeVisibility(item) {
  if (item.visible !== false && isCodePendingConfirmation(item)) {
    return '<span class="admin-status is-pending">待确认</span>';
  }

  if (item.visible === false) {
    return `<span class="admin-status is-rejected" title="${escapeAttr(item.hiddenReason || "")}">已下架</span>`;
  }

  if (isCodeExpired(item)) {
    return '<span class="admin-status is-pending">已过期</span>';
  }

  return '<span class="admin-status is-approved">展示中</span>';
}

function renderCodeActions(item) {
  const actions = [];
  if (!(item.visible !== false && isCodeExpired(item))) {
    const action = item.visible === false ? "restore" : "takedown";
    const label = item.visible === false ? "恢复" : "下架";
    const dangerClass = item.visible === false ? "" : " danger";
    actions.push(`<button class="admin-action-button${dangerClass}" type="button" data-code-action="${escapeAttr(action)}" data-code="${escapeAttr(item.code)}">${escapeHtml(label)}</button>`);
  }

  if (adminState.role === "admin") {
    actions.push(`<button class="admin-action-button danger" type="button" data-code-action="delete" data-code="${escapeAttr(item.code)}">删除</button>`);
  }

  return actions.length ? `<div class="admin-actions">${actions.join("")}</div>` : '<span class="admin-action-placeholder">-</span>';
}

function isPendingReward(value) {
  const reward = String(value || "").trim();
  return !reward || reward === "奖励待确认" || reward === "待确认" || reward === "来源未明确";
}

function isCodePendingConfirmation(item) {
  return item.status === "unknown" || isPendingReward(item.reward) || !item.expireAt;
}

function formatConfidence(confidence) {
  return confidence === "high" ? "高" : "中";
}

function getNewSourceCandidates() {
  return adminState.sourceDraft.candidates.filter((item) => item.duplicateStatus === "new");
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

  document.querySelector("#sourceImportForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    previewImportedCandidates();
  });

  document.querySelector('[data-source-action="publish"]')?.addEventListener("click", publishSourceCandidates);

  document.querySelectorAll("[data-code-action]").forEach((button) => {
    button.addEventListener("click", () => {
      submitCodeAction(button.dataset.code, button.dataset.codeAction);
    });
  });

  document.querySelector('[data-admin-action="logout"]')?.addEventListener("click", logoutAdmin);
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

async function previewImportedCandidates() {
  try {
    const candidates = await readImportCandidates();
    const payload = await postJson("/api/admin/import-preview", { candidates });
    adminState.sourceDraft.candidates = payload.candidates || [];
    adminState.sourceDraft.parsed = true;
    showToast(adminState.sourceDraft.candidates.length ? "候选读取完成" : "文件内没有可导入兑换码");
    renderAdmin();
  } catch (error) {
    showToast(getSourceErrorMessage(error.message));
  }
}

async function publishSourceCandidates() {
  const codes = getNewSourceCandidates().map((item) => item.code);
  if (!codes.length) {
    showToast("没有可直接上架的新候选");
    return;
  }

  try {
    const payload = await postJson("/api/admin/import-publish", {
      codes,
      candidates: getNewSourceCandidates()
    });

    adminState.sourceDraft.candidates = [];
    adminState.sourceDraft.parsed = false;
    adminState.activeTab = "codes";
    window.location.hash = "codes";
    showToast(`已上架 ${payload.created?.length || 0} 条兑换码`);
    await refreshAdmin();
  } catch (error) {
    showToast(getSourceErrorMessage(error.message));
  }
}

async function readImportCandidates() {
  const input = document.querySelector("#sourceImportInput");
  const file = input?.files?.[0];
  if (!file) {
    throw new Error("missing_import_file");
  }

  if (file.size > 60000) {
    throw new Error("import_file_too_large");
  }

  const parsed = JSON.parse(await file.text());
  const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : null;
  if (!candidates) {
    throw new Error("invalid_import_file");
  }

  adminState.sourceDraft.importFile = file;
  adminState.sourceDraft.importFileName = file.name;
  return candidates;
}

async function logoutAdmin() {
  try {
    await postJson("/api/admin/logout", {});
  } finally {
    window.location.replace("/login.html");
  }
}

async function submitCodeAction(code, action) {
  if (!code || !["takedown", "restore", "delete"].includes(action)) {
    return;
  }

  if (action === "delete" && !window.confirm(`确定永久删除兑换码“${code}”吗？关联的使用反馈、奖励反馈和历史提交也会被删除，无法恢复。`)) {
    return;
  }

  try {
    if (action === "delete") {
      await deleteJson(`/api/admin/gift-codes/${encodeURIComponent(code)}`);
    } else {
      await postJson(`/api/admin/gift-codes/${encodeURIComponent(code)}/${action}`, {});
    }
    showToast(action === "restore" ? "已恢复展示" : action === "delete" ? "已永久删除" : "已下架");
    await refreshAdmin();
  } catch (error) {
    showToast(getCodeActionErrorMessage(error.message));
  }
}

function getCodeActionErrorMessage(error) {
  if (error === "code_not_found") {
    return "兑换码不存在";
  }

  if (error === "admin_role_forbidden") {
    return "当前身份无此权限";
  }

  return "操作失败，请稍后再试";
}

function getSourceErrorMessage(error) {
  if (error === "missing_import_file") {
    return "请选择 Codex skill 生成的候选 JSON 文件";
  }

  if (error === "invalid_import_file" || error === "invalid_import_candidates") {
    return "候选文件格式不正确或没有有效候选";
  }

  if (error === "import_file_too_large" || error === "request_body_too_large") {
    return "候选文件过大，请拆分后再导入";
  }

  if (error === "source_candidates_empty") {
    return "没有可直接上架的新候选";
  }

  if (error === "admin_auth_required") {
    window.location.replace("/login.html");
    return "登录已失效";
  }

  return "导入失败，请检查候选文件后重试";
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
    if (response.status === 401) {
      window.location.replace("/login.html");
    }
    throw new Error(payload.error || "request_failed");
  }

  return response.json();
}

async function deleteJson(url) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.replace("/login.html");
    }
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

function formatCodeExpire(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "待确认";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function isCodeExpired(item) {
  const date = new Date(item.expireAt);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
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
