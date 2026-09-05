FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm -r build && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/node_modules packages/server/node_modules
COPY --from=build /app/packages/web/dist packages/web/dist

ENV BUNDLE_ROOT=/bundle PORT=3800
EXPOSE 3800
VOLUME /bundle

# PRISM-49: lets `docker compose up` and `docker ps` report real readiness
# (AC1 — "reachable in a browser") instead of only "container is running".
# Uses node's own http client rather than curl/wget, neither of which ships
# on node:alpine by default.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3800)+'/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
