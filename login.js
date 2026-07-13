const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");

checkSession();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  const password = new FormData(loginForm).get("password");
  const submitButton = loginForm.querySelector("button[type=submit]");
  submitButton.disabled = true;

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "login_failed");
    }

    window.location.replace("/admin.html");
  } catch (error) {
    loginError.textContent = getLoginErrorMessage(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

async function checkSession() {
  try {
    const response = await fetch("/api/admin/session", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (payload.authenticated) {
      window.location.replace("/admin.html");
    } else if (!payload.configured) {
      loginError.textContent = "服务器尚未配置管理员登录。";
    }
  } catch {
    loginError.textContent = "无法连接后台服务。";
  }
}

function getLoginErrorMessage(error) {
  if (error === "invalid_admin_password") {
    return "密码不正确。";
  }

  if (error === "login_rate_limited") {
    return "尝试次数过多，请 15 分钟后再试。";
  }

  if (error === "admin_auth_not_configured") {
    return "服务器尚未配置管理员登录。";
  }

  return "登录失败，请稍后再试。";
}
