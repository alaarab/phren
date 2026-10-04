# The relay for Cloud Run (or any container host): no dependencies, so the
# image is Node plus the compiled files. Build from the repo root:
#   docker build -f packages/push-relay/Dockerfile packages/push-relay
FROM node:26.10.0-alpine AS build
WORKDIR /relay
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@7.0.2 @types/node@26.6.4 >/dev/null && npx tsc -p tsconfig.json

FROM node:26.10.0-alpine
WORKDIR /relay
COPY --from=build /relay/dist ./dist
COPY package.json ./
USER node
# Cloud Run sets PORT and routes to 0.0.0.0.
ENV HOST=0.0.0.0
CMD ["node", "dist/server.js"]
