FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV VAST_AGENT_TRANSPORT=http
ENV VAST_AGENT_DATA_DIR=/data
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/index.js"]
