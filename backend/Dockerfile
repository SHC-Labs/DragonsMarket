FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
RUN test -z "${DATABASE_URL:-}${AGENT_API_KEY:-}${AGENT_GRANT_KEY:-}${OPERATOR_TOKEN:-}"
RUN test -z "${KEEPER_KEY:-}${KEEPER_ORACLE_KEY:-}${KEEPER_MARKET_KEY:-}${KEEPER_COUNCIL_KEY:-}"
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/package.json
COPY contracts/keeper ./contracts/keeper
RUN pnpm install --filter dragons-market-backend --frozen-lockfile
COPY backend ./backend
RUN pnpm build:server && pnpm --filter dragons-market-backend deploy --prod --legacy /runtime

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba
ENV NODE_ENV=production HOST=0.0.0.0 PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /app
COPY --from=build /runtime ./
USER 65532:65532
RUN ["/nodejs/bin/node", "-e", "if(process.getuid()===0)throw Error('root_runtime');console.log('Runtime',process.version,'uid',process.getuid())"]
ENTRYPOINT []
EXPOSE 3500
CMD ["/nodejs/bin/node", "dist/src/main.js"]
