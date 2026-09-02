# MapMold — opcjonalny kontener (włącz / wyłącz w panelu Docker / compose)
FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV STATIC_ROOT=dist
COPY --from=build /app/dist ./dist
COPY web/app.js ./app.js
EXPOSE 3000
CMD ["node", "app.js"]
