# 每日签到面板 — Docker 镜像（Node 运行时，不依赖 Cloudflare）
#
# 一套代码两种跑法：Cloudflare Workers（wrangler deploy）和 Docker（本镜像），
# 面板代码 src/ 完全共用，差异由 docker/adapter.mjs 抹平。

FROM node:24-slim

WORKDIR /app

# telegram（gramjs）是 Telegram 签到（MTProto 用户身份）要用的；
# 其他站点零依赖，node:sqlite 是 Node 24 内置模块。
# --ignore-scripts：telegram 把 bufferutil 列为普通依赖，slim 镜像里没有 Python，
#   装它会触发 node-gyp 编译失败；跳过安装脚本后 bufferutil/utf-8-validate
#   会自动用纯 JS 回退（fallback.js），功能不受影响。
COPY package.json ./
RUN npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
COPY src/ ./src/
COPY public/ ./public/
COPY docker/ ./docker/

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/checkin.sqlite

VOLUME ["/data"]
EXPOSE 8787

# /api/status 无需登录，适合做健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "docker/server.mjs"]
