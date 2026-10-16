FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# No lockfile could be resolved in the authoring environment. After reviewing a
# generated lockfile, replace this command with npm ci and commit the lockfile.
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY activity ./activity
COPY tests ./tests
COPY scripts/bundle-sdk.mjs ./scripts/bundle-sdk.mjs
RUN npm run build && npm test && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 OBJECT_DIR=/data/objects
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY activity/index.html activity/style.css ./activity/
COPY db ./db
RUN mkdir -p /data/objects && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/server/main.js"]
