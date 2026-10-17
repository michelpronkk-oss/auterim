FROM node:24.8.0-alpine3.22@sha256:3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17

RUN apk add --no-cache docker-cli
WORKDIR /opt/auterim-runner
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY archive.ts contracts.ts docker-executor.ts spool.ts server.ts main.ts ./
RUN mkdir -p /srv/auterim-runner && chown -R node:node /opt/auterim-runner /srv/auterim-runner

ENV NODE_ENV=production
ENV PORT=8080
ENV FIX_VERIFICATION_RUNNER_WORK_ROOT=/srv/auterim-runner
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "--experimental-strip-types", "main.ts"]
