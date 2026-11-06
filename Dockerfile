# Decisium runner image: `docker run -v "$PWD:/work" ghcr.io/andletenkov/decisium run features/*.feature`.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
# Outside /root, so the browser stays readable under `docker run --user`.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/decisium
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
RUN chmod +x dist/cli.js && ln -s /opt/decisium/dist/cli.js /usr/local/bin/decisium \
  && decisium install --with-deps --only-shell && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENTRYPOINT ["decisium"]
CMD ["--help"]
