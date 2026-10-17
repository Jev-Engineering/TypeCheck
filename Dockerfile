FROM node:22-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY activity ./activity
COPY tests ./tests
COPY data/scams ./data/scams
COPY scripts/bundle-sdk.mjs ./scripts/bundle-sdk.mjs
# GoDaddy installs production dependencies before building, so build tools are
# declared there. Strip them explicitly from the separate Docker runtime tree.
RUN npm run build && npm test && npm prune --omit=dev \
    && npm uninstall --no-save --ignore-scripts typescript esbuild @types/node

FROM node:22-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules /opt/yarn* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production PORT=3000 OBJECT_DIR=/data/objects
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY activity/index.html activity/style.css ./activity/
COPY activity/legal ./activity/legal
COPY activity/fonts ./activity/fonts
COPY db ./db
COPY data/scams ./data/scams
RUN mkdir -p /data/objects && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/server/main.js"]
