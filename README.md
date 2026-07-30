# Nuvio Provisioner

A self-hosted page that signs in to one or more Nuvio accounts and resets the
profiles you choose to a known-good setup.

After a push, each selected profile has **exactly** these addons and nothing else:

| Addon | Source |
| --- | --- |
| Cinemeta | Official Stremio addon |
| OpenSubtitles v3 | Official Stremio addon |
| Xperience | Your manifest URL |
| AIOStreams | Your 4K **or** 1080p build |

…and exactly the collections in `config/collections.json` — currently
**Streaming**, with 17 folders (Netflix, Prime Video, Disney+, HBO Max, Apple
TV+, Paramount+, Hulu, Peacock, Crunchyroll, MGM+, Discovery+, Criterion
Channel, Crave, CBC Gem, Hayu, Tubi, Pluto TV).

## Run it

```bash
cp .env.example .env                                # AIOStreams URLs
cp config/addons.example.json config/addons.json    # Xperience URL
docker compose up -d
```

Open <http://localhost:8080>. Both copied files are gitignored — see
[Secrets](#secrets).

## How it works

1. **Accounts** — sign in to each Nuvio account. Credentials are forwarded
   straight to `api.nuvio.tv` for a token and are never written to disk or
   logged. Tokens live only in the browser tab.
2. **Profiles** — every profile on every account is listed. Tick the ones to
   reset.
3. **Stream quality** — 4K or 1080p. This decides which AIOStreams build gets
   installed; only one is ever present.
4. **Review & push** — "Preview changes" lists exactly what would be removed,
   per profile, without writing anything. "Push to selected" applies it.

## This is destructive by design

Nuvio's write endpoints (`sync_push_addons`, `sync_push_collections`) are
full-replace, and this tool uses that deliberately: it pushes the exact desired
set, so **anything not in the bundle is deleted**.

That means any other addon a profile had — Torrentio, Comet, a debrid addon,
anything — is removed, and any collection the user built by hand is replaced.
There is no undo.

Two guards: the preview names every addon that would be removed before you
commit, and the push asks for confirmation.

Re-running is safe and idempotent. Switching quality swaps the AIOStreams build
rather than stacking both.

## Configuration

`config/` is mounted read-only into the container. Edit on the host and
`docker compose restart` to pick up changes.

- **`config/addons.json`** (gitignored) — the fixed addon set. Copy from
  `config/addons.example.json`; Cinemeta and OpenSubtitles v3 are already
  filled in, add your Xperience URL.
- **`config/collections.json`** — the collections to apply.
- **`.env`** (gitignored) — `AIOSTREAMS_4K_URL` and `AIOSTREAMS_1080P_URL`.

A quality with no URL set shows as disabled in the UI rather than failing at
push time.

The AIOStreams URLs are read server-side and sent to Nuvio directly. They are
never included in the page source, so the tokens don't leak to the browser.

## The collections depend on the addons

All 103 catalog sources in the `Streaming` collection are bound to the Xperience
addon by id (`app.xperience.fefdfe63-…`), which is why that exact manifest URL
has to be the one installed. Swap in a different Xperience link and the folders
will render empty.

## Hosting the code on GitHub

### Secrets

Two files carry credentials and are gitignored. Never commit them:

| File | Contains |
| --- | --- |
| `.env` | AIOStreams manifest URLs, which embed access tokens |
| `config/addons.json` | The Xperience manifest URL, which embeds a token |

Each has a committed `.example` counterpart with placeholders. Before your first
push, confirm the real ones are excluded:

```bash
git status --porcelain          # neither file should appear
git check-ignore -v .env config/addons.json
```

If you've already pushed either, rotate immediately — deleting a file in a later
commit does **not** remove it from history. Regenerate the Xperience manifest
link and reissue the AIOStreams configs.

`config/collections.json` has no tokens, so it's committed by default. It does
embed your Xperience addon id. If you'd rather not publish that, gitignore it
too.

### Publishing the image

`.github/workflows/docker-publish.yml` builds on every push to `main` and on
`v*` tags, then pushes to GitHub Container Registry. It needs no secrets — the
built-in `GITHUB_TOKEN` is enough. Make sure Actions has package write
permission (Settings → Actions → General → Workflow permissions).

Images land at `ghcr.io/<you>/nuvio-provisioner`. To deploy from that instead of
building locally, swap `build:` for `image:` in `docker-compose.yml`.

The image ships without your real config — mount it at runtime, as the compose
file already does, and pass the env vars.

### GitHub Pages won't work

Pages only serves static files. This is a Node server, and it needs to be: it
proxies the Nuvio API so your password isn't subject to browser CORS rules, and
it keeps your manifest URLs out of the page source. Use the container on any
host that runs Docker, or a platform like Fly, Render, or Railway that builds
from a Dockerfile.

## Notes

- Both addon URLs embed a token tied to one subscription. Installing them across
  several accounts means those accounts share your Xperience profile and your
  AIOStreams instance.
- Point AIOStreams at a publicly reachable hostname, not a LAN address like
  `192.168.x.x` — a LAN IP only resolves on your own network.
- Access tokens expire after roughly 60 minutes. If a push fails with an auth
  error after the page has been open a while, re-add the account.
- The container runs as the unprivileged `node` user and exposes `/healthz`.
- Not affiliated with Nuvio. Uses the documented public API at
  <https://nuvio.tv/docs>.
