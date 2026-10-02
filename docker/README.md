# Docker 运行方式

同一套代码，两种跑法：

| 方式 | 命令 | 数据 | 定时 |
|---|---|---|---|
| Cloudflare Workers | `wrangler deploy` | D1（云端） | Cron 每分钟 |
| Docker（本页） | `docker compose up -d` | SQLite（本地 `./data`） | 容器内每分钟 |

面板代码 `src/` 完全共用，差异由 `docker/adapter.mjs` 抹平（D1 接口 → Node 内置 `node:sqlite`，静态资源 → `public/` 目录）。

## 快速开始

**一键安装**（SSH 连上 NAS/主机，粘贴这一行；重复跑一遍就是更新，数据不受影响）：

```bash
curl -fsSL https://raw.githubusercontent.com/guoxpeng/daily-checkin-panel/master/install.sh | bash
```

装完打开 `http://你的IP:8787`，首次会让你设置管理密码，之后和 Cloudflare 版用法完全一样。

<details>
<summary>手动安装（不想用脚本的话）</summary>

```bash
cp .env.example .env
# 可选：填 ENCRYPT_KEY（openssl rand -base64 32 生成；不填面板会自动生成存库）
docker compose up -d
```
</details>

## 配置说明（.env）

- `ENCRYPT_KEY`：账号凭据的加密密钥，32 字节 base64（`openssl rand -base64 32`）。
  不填也行，面板首次使用时会自动生成一把存进数据库。**投入使用后不要改**，改了旧凭据解不开。
- `PORT`：面板端口，默认 8787。
- `TZ`：时区，只影响容器日志时间；签到时间走面板「设置」页。

## 数据与备份

所有数据（账号、日志、设置、自动生成的加密密钥）都在 `./data/checkin.sqlite` 这一个文件里（+WAL 临时文件）。备份直接拷走 `data/` 目录就行；迁到别的机器也是拷这个目录。

## 更新（git push 后自动）

CI（`.github/workflows/docker.yml`）在每次 push 到 master 后自动构建多架构镜像（amd64+arm64，NAS/树莓派能用）并推送到 Docker Hub（`nameguoguo/daily-checkin-panel`），打 tag 会额外出版本号标签。**不需要人工 `docker push`**。

服务器上更新，三选一：

```bash
# 1. 手动（推荐）：拉新镜像并重启
docker compose pull && docker compose up -d

# 2. 全自动：watchtower 每 5 分钟检查一次，有新镜像自动更新（只动本面板容器）
docker compose --profile auto-update up -d
```

## 网络模式（为什么默认 host）

`docker-compose.yml` 默认用 `network_mode: "host"`（容器直接用主机的网络栈），两个原因：

1. **NodeSeek 这类站点要求 IPv6**：直连签到需要容器的 IPv6 出口，而 Docker 默认的 bridge 网络是纯 IPv4（除非你单独给 Docker daemon 开了 IPv6）。host 模式下容器直接走主机的 IPv6，和你在家用浏览器签到是同一个网络。
2. 家用 NAS/软路由上最省事，不用再映射端口。

注意：Mac/Windows 的 Docker Desktop 不支持 host 模式（会被忽略），请用 Linux 主机。如需改回 bridge，注释掉 compose 里那行并取消 `ports` 的注释，同时要在 Docker daemon 里开 IPv6（`/etc/docker/daemon.json` 加 `"ipv6": true`），否则 NodeSeek 直连签到会被踢到 IPv6 提示页而失败。

## Telegram 签到（Docker 版专属）

给指定的 TG 机器人/群发签到指令（如机场群的 `/checkin` 领流量）。**只能跑在 Docker 版**：它用 MTProto 以「你的 Telegram 账号」身份登录，需要 TCP 长连接，Cloudflare Workers 没有 TCP，跑不了。在 Workers 上建这个账号会直接提示换 Docker 版。

用之前先装依赖（镜像构建时已自动装好，`package.json` 里有 `telegram` 一项）。

### 一次性：申请 API 凭据 + 登录拿 Session

1. 去 https://my.telegram.org 用手机号登录 → **API development tools** → 建一个应用，拿到 `api_id`（数字）和 `api_hash`。
2. 在跑容器的机器上执行（`-it` 是必须的，要交互输入）：

```bash
docker exec -it daily-checkin-panel node docker/telegram-login.mjs
```

按提示输入 `api_id` / `api_hash` / 手机号（带国家码，如 `+86` 开头）/ 手机收到的验证码 / 两步验证密码（没设直接回车）。成功后会输出一段 **Session** 字符串。

3. 面板里「添加账号」选 **Telegram 签到**，填：
   - `API ID` / `API Hash`：第 1 步拿到的；
   - `Session`：第 2 步输出的那段（很长，完整粘贴）；
   - `签到目标`：`@机器人用户名` 或群链接（如 `@checkin_bot`）；
   - `签到指令`：默认 `/checkin`；
   - `成功关键词` / `已签到关键词`：用来判断 bot 回执，默认 `签到成功` / `已签到`（多个用 `|` 分隔）。

之后每天到点，面板就以你的账号身份进群发指令，bot 的回执会原样记在「网站反馈」里。

安全提醒：Session 等于你的 Telegram 登录态，面板里是加密存的，但**不要截图发给别人**，也不要提交到 git（本来也不在仓库里）。

## 扩展配合

扩展里的「面板地址」填 `http://你的IP:8787`（或域名）。注意两点：

1. 公网地址必须用 **https**；**局域网地址可以用 http**（如 `http://192.168.x.x:8787`，流量不出内网）。想要公网 https 就配反向代理（下面有 Caddy 示例）。
2. 「📥 下载扩展」按钮注入的是你当前访问的地址，用什么地址打开面板，扩展里就带出什么地址。

## 反向代理（可选，Caddy 示例）

```caddy
checkin.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 自动申请 Let's Encrypt 证书，配好后扩展填 `https://checkin.example.com` 即可。

## 常见问题

- **端口被占用**：改 `.env` 里 `PORT`，如 `PORT=8080`。
- **忘记管理密码**：删 `./data/checkin.sqlite` 重来（所有账号数据一起没，慎用），或进库改 `settings` 表（不建议）。
- **ENCRYPT_KEY 丢了/改了**：已存账号的凭据解不开，只能删库重建。备份好 `./data`。
- **定时没跑**：面板「设置」页看「自动执行」心跳；容器日志 `docker compose logs -f` 看 `[cron]`。
