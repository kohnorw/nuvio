# Nuvio Setup

Self-hosted admin page that signs in to Nuvio, picks profiles, and does a clean
install of a fixed addon set (from `config/addons.json` plus your chosen
AIOStreams build) and the bundled **Streaming** and **Genres** collections.

## Setup

```bash
cp .env.example .env
nano .env                       # AIOSTREAMS_4K_URL, AIOSTREAMS_1080P_URL
cp config/addons.example.json config/addons.json
nano config/addons.json         # your Xperience manifest URL
docker compose up -d --build
```

Admin page: `http://<host>:7000/` (the root redirects to `/admin/`).

## Using the prebuilt image

Every push to `main` publishes `ghcr.io/kohnorw/nuvio:latest` (amd64 and arm64),
also tagged `sha-<commit>` for pinning or rolling back.

```bash
mkdir -p nuvio/config && cd nuvio
RAW=https://raw.githubusercontent.com/kohnorw/nuvio/main
curl -fsSLO $RAW/docker-compose.yml
curl -fsSL -o .env $RAW/.env.example
for f in collections.json collections.genre.json layout.json; do curl -fsSL -o config/$f $RAW/config/$f; done
curl -fsSL -o config/addons.json $RAW/config/addons.example.json
nano .env config/addons.json
docker compose pull && docker compose up -d
```

Updating is `docker compose pull && docker compose up -d`.

## Using it

1. Sign in with the **Nuvio** account (add as many as you like).
2. Pick the profiles and the stream quality.
3. **Preview changes** — read what it will remove — then push.
4. Fully close and reopen Nuvio. Collections are cached per profile.

Collection order comes from `config/layout.json`.
