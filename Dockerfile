FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# sharp resizes the station logos; the font is what lets a channel with no
# logo get a tile with its initials rather than an empty box.
RUN apk add --no-cache font-dejavu

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY admin ./admin
COPY public ./public
COPY scripts ./scripts
# config/ is mounted at run time so the addon list can be edited without a
# rebuild; this copy is the fallback when nothing is mounted.
COPY config ./config

EXPOSE 7000

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "src/server.js"]
