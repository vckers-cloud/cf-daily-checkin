# 每日签到面板

**一句话**：把你每天要手点的那些「签到」，交给它每天自动点一遍，签完还会推到你手机上。

跑在 Cloudflare 上，**免费**。只要一个 Cloudflare 免费账号，不用买服务器、不用信用卡、不用域名。

<p>
  <a href="https://github.com/guoxpeng/daily-checkin-panel"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-guoxpeng%2Fdaily--checkin--panel-5b8cff?logo=github"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3ddc84"></a>
  <a href="CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-ffb020"></a>
</p>

> 💬 遇到签到问题 / 想提建议？先来这里：[NodeSeek 使用反馈收集帖](https://www.nodeseek.com/post-956355-1#1)（反馈集中收集，留言前先看看有没有人遇到过）

---

## 部署到 Cloudflare（纯网页，不用装任何东西）

**准备**：一个 Cloudflare 免费账号、一个 GitHub 账号、大约 20 分钟。**不用装 Node.js、不用命令行、不用买域名。**

1. **把项目放进你的 GitHub**：打开本项目仓库 → 右上角 **Fork** → 得到你自己的仓库（后面 Cloudflare 从这里拉代码）。
2. **建数据库**：Cloudflare 控制台 → **存储和数据库 → D1 SQL 数据库 → 创建** → 名字填 `daily-checkin-panel`
   （**必须一模一样**，代码按这个名字找库）→ 建完进详情页，复制那串 **数据库 ID**（形如 `8f1a-…-e7f8` 的 UUID）。
3. **把 ID 填回仓库**：回到你的 GitHub 仓库 → 打开 `wrangler.toml` → 点铅笔编辑 →
   把 `database_id = "REPLACE_ME_WITH_YOUR_OWN_D1_ID"` 里的占位符换成刚才那串 → **Commit changes**。
4. **建 Worker 并连接仓库**：Cloudflare 控制台 → **Workers 和 Pages → 创建应用程序 → 导入存储库（Import a repository）**
   → 选你的 fork → 部署命令保持默认（`npx wrangler deploy`）→ **保存并部署**。
   部署完会给你面板地址：`https://daily-checkin-panel.<你的子域>.workers.dev`，复制存好。
5. **设加密密钥（Secret）**：Worker 详情 → **设置 → 变量和密钥 → 添加** → 类型选 **Secret** →
   名称 `ENCRYPT_KEY` → 值填一段 32 字节的 base64 随机串 → 保存。
   随机串哪来：任意浏览器按 F12 → Console（控制台页面，下面有个">"符号）后面粘贴
   `btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))` 回车，输出那串就是；
   或是网上随机网站生成一个：https://generate-random.org/base64-string → Byte Count 填 32 →
   点 EXECUTE GENERATION → 点生成的串直接复制。
   （**丢了就解不开已存的 Cookie**，记到密码管理器里）。设完在 Worker 页点一次 **重新部署** 生效。

> 以后项目更新了：在你 fork 的仓库点 **Sync fork** → Cloudflare 自动重新部署，数据库里的数据不受影响。
> 每一项「叫什么名字、填什么值」的完整对照表 → [Cloudflare 部署清单](docs/Cloudflare部署清单.md)。

<details>
<summary><b>备用：命令行一键部署</b>（电脑上装了 Node.js 的话更快）</summary>

```bash
node deploy.mjs
```

它会按顺序帮你：检查环境 → 登录 Cloudflare → 建免费数据库并自动写进 `wrangler.toml` →
生成加密密钥 → 部署前把关 → 部署 → **当场验收**（首页能不能开、数据库通不通，哪项没过会直接告诉你敲哪几条命令）。
只想先体检、不发布：`node deploy.mjs --check`。

</details>

想一步步手动做、或部署报错要弄清原因 → [详细手册](docs/详细手册.md)。

---

## Docker 部署（家里 NAS / 软路由 / 常开主机）

什么时候选它：想用 **Telegram 签到**（只有 Docker 版能跑），或想走**家里宽带的 IPv6**（NodeSeek 这类站点在 Cloudflare 机房网络下不稳定）。

**一键安装**（SSH 连上 NAS，粘贴这一行）：

```bash
curl -fsSL https://raw.githubusercontent.com/guoxpeng/daily-checkin-panel/master/install.sh | bash
```

脚本会：检查 docker → 建 `~/daily-checkin-panel` 目录 → 下载最新配置 → 生成 `.env` → 拉镜像启动。装完浏览器打开 `http://你的NAS_IP:8787`，首次设置管理密码，之后用法和 Cloudflare 版完全一样。数据全在 `./data/checkin.sqlite` 一个文件里，备份拷走就行。**重复跑一遍就是更新**（数据不受影响）。

<details>
<summary>手动安装（不想用脚本的话）</summary>

```bash
cp .env.example .env   # 可选：填 ENCRYPT_KEY（openssl rand -base64 32 生成；不填面板自动生成）
docker compose up -d
```
</details>

- 镜像：`nameguoguo/daily-checkin-panel`（amd64+arm64，NAS/树莓派能用），每次 push 代码后 CI 自动构建推送；
- 更新：`docker compose pull && docker compose up -d`；
- 默认 host 网络模式（直接拿主机 IPv6，给 NodeSeek 直连用），Mac/Windows 的 Docker Desktop 请用 Linux 主机。

完整说明（Telegram 签到步骤、反向代理、常见问题）→ [docker/README.md](docker/README.md)。

---

## 部署完还要做 4 件事

**1. 打开面板设置管理密码**（至少 8 位）。⚠️ 记到密码管理器里，忘了没法找回。

**2. 生成扩展的 API Key**：设置 →「🔌 浏览器扩展」→ **🎲 重新生成 API Key**。
⚠️ 这串 Key **只在生成那一刻显示一次**，页面上没有「查看」。生成后马上点 **📋 复制**，粘进扩展弹窗；
忘了就再生成一把（旧的立刻失效）。

**3. 装浏览器扩展**：同一张卡点 **⬇️ 下载 签到面板助手** → 解压到固定文件夹（**别删别移动**）
→ `chrome://extensions` 打开**开发者模式** → **加载已解压的扩展程序** 选那个**文件夹本身**
→ 点 🍪 图标填 API Key → **🔌 面板连接检查**显示「连接正常」即成功。
（下载包**已自动写好你现在的面板地址**，不用手抄；面板里的「安装步骤」折叠块有同样的 4 步。）

**4. 加第一个账号**：打开目标网站**手动登录** → 停在网站上，点扩展 **📋 一键复制全部信息（含 UA）**
→ 面板「添加 / 更新账号」→「📋 粘贴即保存」里 **Ctrl+V** → 面板自动认站点、填信息、立刻试跑。
要加第二个网站就再来一遍这 4 步。

> 同一张卡另一个标签 **🔍 Cookie 解析器**（默认就在那儿）：粘一串 Cookie 点「拆分看看」，
> 逐段告诉你每段是什么、哪些是登录必需，**只看不存**；没问题再点「↗️ 填到粘贴区并保存」。

---

## 日常怎么用

| 我想…… | 怎么做 |
|---|---|
| 马上签一次 / 全部签一次 | 那一行点 **执行** / 右上角 **全部执行** |
| 改签到时间 | 账号页「全局签到」：点 `每天 08:05`、`时区 中国台湾 · 台北` 两个胶囊，**选好即自动保存**，改完立刻生效 |
| 给某个账号单独一个时间 | 表格「全局签到」列点一下自己选（点「跟随全局」就回去） |
| 暂时不签某个账号 | 那一行的开关关掉 |
| 看每次签的结果、网站原话 | 页面顶部 **运行日志** |
| 看这份登录还能撑多久 | **鼠标移到那一行的站点名上**（名字下面有条虚线），弹出这套凭据的到期时间 |
| 看某个账号为什么没签上 | 「网站反馈」那列；底下有「💡 建议」胶囊时**鼠标移上去**看完整内容 |
| 换个主题 | 右上角主题按钮点一下换一种（跟随系统 / 浅色 / 深色） |

**状态列**：✅ 已签到 · 🔴 未签到（过了你设的时间会全部回到这个状态，签成功才变 ✅）· ⏭️ 跳过（这次没跑，不算失败）。
每天合不合适，右上角那个**网络连接状态**（阿里 / 谷歌 / Facebook / GitHub / Telegram / 百度）能帮你判断是面板出口的问题还是某个站自己的问题。

---

## 推送通知（Telegram，4 步）

面板 → **设置** →「推送通知」→ **📨 Telegram**：

1. Telegram 里找 **@BotFather** → 发 `/newbot` → 按提示走完，拿到 **Bot Token**
2. 粘进面板「Bot Token」
3. **用你自己的 Telegram 给这个 Bot 发一句「hi」**（要推群里就把 Bot 拉进群再在群里发一句）
4. 点 **🔍 自动获取 Chat ID** → 选一个会话 → **📨 发送测试消息**

收到就说明通了。勾上「启用推送」→ **保存推送设置**，以后每天签完自动发汇总。
不想用 Telegram？同一页还有 **Bark**（iPhone）和**通用 Webhook**，填一个就行。

---

## 出问题怎么办

| 现象 | 怎么办 |
|---|---|
| 面板打不开，或扩展老是「连接失败」 | `*.workers.dev` 在国内有时连不上，**绑一个自己的域名**可彻底解决（见[详细手册](docs/详细手册.md)）；换域名后记得去扩展弹窗改地址 |
| 扩展显示「离线」 | 点扩展图标检查「签到面板地址」「API Key」，再点「🔌 面板连接检查」 |
| 「登录已失效 / Cookie 已失效」 | 去那个网站重新登录，再走一遍「加第一个账号」的复制粘贴 |
| 「需要本地网络」 | 打开浏览器、确认扩展启用。有些站会拦机房 IP，只能走你家网络（这就是扩展的用处） |
| 明明签了却写「未签到」 | 点那一行的 **执行**，看「网站反馈」——那是网站自己的原话，不会骗人 |
| 想换 / 忘了管理密码 | 设置 →「修改管理密码」（改完其它浏览器会退出登录）；忘了按[详细手册](docs/详细手册.md)里那条命令清掉重设 |

更多疑难杂症（每种网站的坑、执行模式怎么选、Cookie 怎么手动取）见[详细手册](docs/详细手册.md)。

---

## 开源共建

**面板里没有写死任何网站。** 任何能在浏览器里手动签到的站都能做适配：

1. 用「自定义 HTTP」把签到调通（F12 →「复制为 cURL」，支持多步）
2. **设置** →「🌍 社区站点（开源共享）」→ 选一个**签到网站** →「📤 导出为社区配置」
   （选的是网站不是账号：分享出去的是「这个网站怎么签」；一个站下多个账号时面板自己挑调通过的那个）
3. 配置里的 Cookie / 密码会被换成 `{{cookie}}` 这类占位符，导出一段 JSON，发到 Issue / PR
4. 别人在同一处粘贴导入，**立刻能用，不用改代码、不用重新部署**

规范与现成示例见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [community/README.md](community/README.md)。
**导出的配置里绝不会带登录信息**：导出时自动清洗，导入时校验器直接拒绝带明文 Cookie 的配置。

---

## 数据与安全

| 你关心的 | 实际情况 |
|---|---|
| 账号密码 / Cookie 存在哪？ | 你自己的 Cloudflare D1 里，AES-GCM **加密**后存储；密钥只在你自己的 Worker 上（`ENCRYPT_KEY`） |
| 面板有防护吗？ | 管理接口都要登录；连续输错会临时锁定；改密码踢掉所有会话；跨站请求拒绝；CSP 等安全头。清单见 [SECURITY.md](SECURITY.md) |
| 扩展能干什么？ | 只读你**当前正在看的那一个网站**的 Cookie，不点按钮什么都不做；代发请求只允许公网 http(s)，内网 / 本机地址一律拒绝 |
| 会不会被公开？ | 面板地址只有你知道；API Key 只手动填进扩展，不会写进下载包 |

请只用来签**你自己的**账号。使用本项目产生的后果由使用者自己承担（见 [LICENSE](LICENSE)）。

---

## 文档与开发

| 文件 | 内容 |
|---|---|
| [docs/Cloudflare部署清单.md](docs/Cloudflare部署清单.md) | 部署要填什么：D1 名字、绑定名、`database_id`、各变量 |
| [docker/README.md](docker/README.md) | Docker 部署完整说明：快速开始、配置、更新、host 网络、Telegram 签到、反向代理、FAQ |
| [docs/详细手册.md](docs/详细手册.md) | 手动部署、执行模式、内置站点、社区适配、FAQ、备份与结构 |
| [SECURITY.md](SECURITY.md) / [CONTRIBUTING.md](CONTRIBUTING.md) | 安全说明 / 怎么贡献一个站点适配 |
| [CHANGELOG.md](CHANGELOG.md) | 每一版改了什么 |
| [NodeSeek 使用反馈收集帖](https://www.nodeseek.com/post-956355-1#1) | 用户反馈集中收集（遇到签到问题先来这里看看/留言） |

```bash
node tools/verify.mjs        # 自检：语法 + HTML 配对 + DOM 引用 + 全部单测（CI 跑的是它）
node tools/pack-zip.mjs      # 打发布包（release/*.zip，带 SHA-256）
node tools/release.mjs minor # 发版：自检 → 升版本号 → 写 CHANGELOG → 打发布包，再提示 git 命令
```

`.github/workflows/` 里：`ci.yml` 每次推送/PR 自检；`release.yml` 推 `v*` tag 自动发 Release；
`deploy.yml` 是可选手动部署（默认只 dry-run）。自检不需要 `npm install`（`telegram` 依赖只在站点模块里动态 import，只有 Docker 镜像构建时才装）。

```
wrangler.toml  部署配置（数据库 id、定时触发器）      deploy.mjs  一键部署脚本
src/           Worker 端代码（路由、站点适配、加密、定时任务）
public/        网页面板（index.html 就是整个后台界面）
test/  tools/  单测 / 自检与发版脚本          docs/  community/  文档 / 社区站点配置
```

自己加一个内置站点：在 `src/sites/` 加一个模块，再到 `src/sites/index.js` 注册，然后 `node tools/verify.mjs`。

---

## 许可

[MIT](LICENSE)
