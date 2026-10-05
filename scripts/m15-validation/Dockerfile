FROM node:24.8.0-alpine3.22@sha256:3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17

WORKDIR /opt/tooling
COPY tests/fixtures/m15-money-path/package.json tests/fixtures/m15-money-path/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN printf '%s\n' '#!/bin/sh' 'set -eu' 'cd /work' 'node --test test/*.mjs' 'node /opt/tooling/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json' > /usr/local/bin/auterim-validate \
  && chmod 0555 /usr/local/bin/auterim-validate
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/auterim-validate"]
