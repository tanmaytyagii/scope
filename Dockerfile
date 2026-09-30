# syntax=docker/dockerfile:1
#
# SCOPE server image. Builds every package, packs them exactly as they would be published, and
# installs the packs into a clean runtime image — so the container runs what users would install.
#
#   docker build -t scope .
#   docker run -p 4700:4700 -e SCOPE_DATABASE_URL=postgres://… scope            # scope server
#   docker run --rm -e SCOPE_DATABASE_URL=… scope keys create --project app --scope ingest

# Pinned by digest (the multi-platform index); Dependabot proposes updates.
FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund --loglevel=error \
 && npm run build \
 && mkdir /packs \
 && for ws in core config providers sdk evaluators engine storage protocol cli; do \
      npm pack -w "@scope-ai/$ws" --pack-destination /packs --silent; \
    done \
 && npm pack -w @scope-ai/server -w @scope-ai/web --pack-destination /packs --silent

FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
ENV NODE_ENV=production \
    SCOPE_HOST=0.0.0.0 \
    SCOPE_PORT=4700 \
    SCOPE_LOG_FORMAT=json
WORKDIR /opt/scope
COPY --from=build /packs /tmp/packs
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error /tmp/packs/*.tgz \
 && rm -rf /tmp/packs /root/.npm
ENV PATH=/opt/scope/node_modules/.bin:$PATH
# The runnable examples, used by the docker compose demo.
COPY --chown=node:node examples /opt/scope/examples
COPY --chown=node:node docker/seed-demo.sh /opt/scope/seed-demo.sh
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /data
EXPOSE 4700
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SCOPE_PORT||4700)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["scope"]
CMD ["server"]
