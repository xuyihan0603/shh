FROM node:24.22.3-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STORE_BACKEND=mysql \
    STORE_MODE=wechat-test \
    MYSQL_DATABASE=shh_booking_test \
    WECHAT_APP_ID=wxa3eaf9dbbf214997 \
    WECHAT_CLOUD_ENV=prod-d4goi868p5197ee86 \
    TZ=Asia/Shanghai

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

WORKDIR /app
COPY --chown=node:node server/ server/
COPY miniprogram/lib/ miniprogram/lib/

USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
