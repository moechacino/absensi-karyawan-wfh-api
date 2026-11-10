FROM node:26.13.0-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@11.20.0

COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26.13.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/absensi/files \
    && chown node:node /var/lib/absensi/files \
    && chmod 700 /var/lib/absensi/files

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
CMD ["node", "dist/main.js"]
