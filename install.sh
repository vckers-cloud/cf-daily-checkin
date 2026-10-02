#!/usr/bin/env bash
# 每日签到面板 — 一键安装 / 更新（家用 NAS / Linux 主机）
#
# 用法（SSH 连上 NAS 后粘贴这一行）：
#   curl -fsSL https://raw.githubusercontent.com/guoxpeng/daily-checkin-panel/master/install.sh | bash
#
# 做了什么：
#   1. 检查 docker、docker compose 是否可用
#   2. 在 ~/daily-checkin-panel 建目录（改位置：INSTALL_DIR=/volume1/docker/checkin bash …）
#   3. 下载最新的 docker-compose.yml（NAS 上没有源码，不需要 build，直接拉镜像）
#   4. 没有 .env 就生成一个（ENCRYPT_KEY 留空，面板首次启动会自动生成存库）
#   5. 建 data/ 目录（SQLite 数据全在这里，备份拷走就行）
#   6. 拉最新镜像并启动（--pull always，保证拿到的是新版）
# 重复执行 = 更新到最新版，账号数据不受影响。
set -euo pipefail

REPO="guoxpeng/daily-checkin-panel"
BRANCH="master"
INSTALL_DIR="${INSTALL_DIR:-$HOME/daily-checkin-panel}"
BASE_URL="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

info() { echo "==> $*"; }
die() { echo "❌ $*" >&2; exit 1; }

# 下载工具二选一
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "没找到 curl/wget，装一个再跑"
  fi
}

# 1. 检查 docker
command -v docker >/dev/null 2>&1 || die "没找到 docker：群晖去套件中心装 Container Manager；其他 Linux 按官网装 Docker"
docker compose version >/dev/null 2>&1 || die "docker compose 不可用（要 v2；群晖 Container Manager 自带）"

# 2. 建目录
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 3. 下载 compose 文件（已有先备份；NAS 上没有源码，去掉 build 只拉镜像）
if [ -f docker-compose.yml ]; then
  cp docker-compose.yml "docker-compose.yml.bak.$(date +%Y%m%d%H%M%S)"
  info "已备份旧的 docker-compose.yml"
fi
fetch "${BASE_URL}/docker-compose.yml" docker-compose.yml
sed -i '/^[[:space:]]*build: \.$/d' docker-compose.yml
info "已下载最新 docker-compose.yml"

# 4. .env（没有才生成，绝不覆盖已有的）
if [ ! -f .env ]; then
  {
    echo "# 由一键安装脚本生成（$(date '+%F %T')）"
    echo "# ENCRYPT_KEY 留空：面板首次启动会自动生成并存进数据库；"
    echo "# 投入使用后不要改，改了已存账号的 Cookie 解不开。"
    echo "ENCRYPT_KEY="
    echo "PORT=8787"
    echo "TZ=Asia/Shanghai"
  } > .env
  info "已生成 .env（ENCRYPT_KEY 留空，面板会自动生成）"
fi

# 5. 数据目录
mkdir -p data

# 6. 拉镜像并启动
info "正在拉取镜像并启动…"
docker compose pull --quiet
docker compose up -d --pull always --remove-orphans

# 7. 等一两秒确认容器活着
sleep 2
if ! docker compose ps --status running --quiet | grep -q .; then
  die "容器没跑起来，看日志：cd $INSTALL_DIR && docker compose logs"
fi

# 8. 输出访问地址
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-你的NAS_IP}"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-8787}"
echo ""
echo "✅ 完成！浏览器打开：http://${IP}:${PORT}"
echo "   首次打开会让你设置管理密码（记到密码管理器里）。"
echo ""
echo "   更新：重新跑一遍安装命令即可（数据不受影响）"
echo "   日志：cd ${INSTALL_DIR} && docker compose logs -f"
echo "   停止：cd ${INSTALL_DIR} && docker compose down"
