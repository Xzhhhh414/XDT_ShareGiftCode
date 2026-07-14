# 服务器 IP 直连部署准备

本目录用于将 API、SQLite 和管理员后台部署到腾讯云轻量应用服务器。玩家静态页面不部署在服务器，由 TapTap 第三方工具托管。

本方案将玩家工具的 API 指向公网 IPv4 `124.222.121.67`。Node 仅绑定
`127.0.0.1:4173`，由 Caddy 在公网 `443` 端口提供 HTTPS；不要把 Node 的
`4173` 端口开放到安全组。

在将工具交给玩家前，必须通过 acme.sh 的 Let's Encrypt `shortlived` profile
申请受浏览器信任、且证书主题包含该 IPv4 地址的证书。IP 证书有效期约 6 天，
必须登记 acme.sh 续期后自动 reload Caddy。若证书不受信任，HTTPS 页面不能安全地调用该 API。

## 初始化服务

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

在服务器上验证 Node 只监听本机：

```bash
curl http://127.0.0.1:4173/api/health
systemctl status xdt-share-gift-code --no-pager
```

## 配置公网 IP HTTPS

1. 在腾讯云安全组开放 `80`、`443`，不开放 `4173`。Caddy 的公网地址为 `https://124.222.121.67`。
2. 停止 Caddy，安装 acme.sh，并使用 Let's Encrypt 的 IP 短期证书 profile 申请证书：

```bash
systemctl stop caddy
curl https://get.acme.sh | sh -s email=YOUR_EMAIL
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt
~/.acme.sh/acme.sh --issue --standalone --cert-profile shortlived --keylength ec-256 -d 124.222.121.67
```

3. 将证书部署到 Caddy 可读取的目录。`--ecc` 必须保留，它表示使用上一步生成的 EC 证书：

```bash
install -d -o root -g caddy -m 750 /etc/caddy/certs
~/.acme.sh/acme.sh --install-cert -d 124.222.121.67 --ecc \
  --key-file /etc/caddy/certs/124.222.121.67.key \
  --fullchain-file /etc/caddy/certs/124.222.121.67.fullchain.crt
chown root:caddy /etc/caddy/certs/124.222.121.67.key /etc/caddy/certs/124.222.121.67.fullchain.crt
chmod 640 /etc/caddy/certs/124.222.121.67.key
chmod 644 /etc/caddy/certs/124.222.121.67.fullchain.crt
```

4. 安装仓库 Caddyfile 并启动 Caddy。该配置的 `default_sni` 是必要项：直接访问 IP 的客户端通常不会发送 TLS SNI，Caddy 必须以它选中 IP 证书：

```bash
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
```

5. 重新登记部署动作，保证每次续期都更新文件权限并 reload Caddy：

```bash
~/.acme.sh/acme.sh --install-cert -d 124.222.121.67 --ecc \
  --key-file /etc/caddy/certs/124.222.121.67.key \
  --fullchain-file /etc/caddy/certs/124.222.121.67.fullchain.crt \
  --reloadcmd 'chown root:caddy /etc/caddy/certs/124.222.121.67.key /etc/caddy/certs/124.222.121.67.fullchain.crt && chmod 640 /etc/caddy/certs/124.222.121.67.key && chmod 644 /etc/caddy/certs/124.222.121.67.fullchain.crt && systemctl reload caddy'
```

6. 使用 `curl -v https://124.222.121.67/api/health` 与浏览器检查证书；只有两者均成功且浏览器无证书警告时，才继续。
7. 在 TapTap 测试工具页确认实际页面 Origin 后，将其填入 `/etc/xdt-share-gift-code.env` 的 `PLAYER_CORS_ORIGINS`，再执行 `systemctl restart xdt-share-gift-code`。
8. 设置 `TAPTAP_API_BASE_URL=https://124.222.121.67`，运行 `npm run package:taptap` 生成 GitHub Release ZIP。

如果 Caddy 无法取得受信任的 IP 地址证书，或 TapTap 的 CSP 拒绝连接 IP 地址，
此方案不能向玩家发布；保留服务器内部服务与 SQLite 数据，再改用其他受支持的
HTTPS 入口。
