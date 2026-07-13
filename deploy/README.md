# 服务器部署准备

本目录用于将 API、SQLite 和管理员后台部署到腾讯云轻量应用服务器。玩家静态页面不部署在服务器，由 TapTap 第三方工具托管。

## 备案审核期间

以下步骤只准备本机回环服务，不开放玩家访问：

```bash
apt-get update
apt-get install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

node --version
git clone https://github.com/Xzhhhh414/XDT_ShareGiftCode.git /opt/xdt-share-gift-code
useradd --system --create-home --shell /usr/sbin/nologin xdtgift
chown -R xdtgift:xdtgift /opt/xdt-share-gift-code

cd /opt/xdt-share-gift-code
install -m 600 deploy/xdt-share-gift-code.env.example /etc/xdt-share-gift-code.env
install -m 644 deploy/xdt-share-gift-code.service /etc/systemd/system/xdt-share-gift-code.service
systemctl daemon-reload
systemctl enable --now xdt-share-gift-code
```

编辑 `/etc/xdt-share-gift-code.env`，把 `ADMIN_PASSWORD` 替换为仅自己保存的随机密码。服务首次以 SQLite 启动时，会将仓库中的 `server/db.json`（若存在）或 `server/db.seed.json` 写入 `/var/lib/xdt-share-gift-code/db.sqlite`。

如需保留本地后台已导入的数据，在首次启动服务前，从本机执行：

```powershell
scp .\server\db.json root@124.222.121.67:/opt/xdt-share-gift-code/server/db.json
```

在服务器上验证服务只监听本机：

```bash
curl http://127.0.0.1:4173/api/health
systemctl status xdt-share-gift-code --no-pager
```

## 备案通过后

1. 安装 Caddy：`apt-get install -y caddy`。
2. 将配置安装为 `install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile`，再执行 `systemctl reload caddy`。
3. 在腾讯云安全组开放 `80`、`443`，不开放 `4173`。
4. 在 TapTap 测试工具页确认实际页面 Origin 后，将其填入 `/etc/xdt-share-gift-code.env` 的 `PLAYER_CORS_ORIGINS`，再执行 `systemctl restart xdt-share-gift-code`。
5. 设置 `TAPTAP_API_BASE_URL=https://code.xdtgift.site`，运行 `npm run package:taptap` 生成 GitHub Release ZIP。
