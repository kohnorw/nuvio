# Nuvio Live TV

Self-hosted Live TV for Nuvio, in one folder, one container, one port.

- **The addon** turns an Xtream Codes login into a Stremio/Nuvio addon with
  station logos and XMLTV guide data.
- **The admin page** (`/admin`) signs in to Nuvio, picks profiles, takes a
  customer's IPTV login, and installs the addon plus the **Live TV** collection.

The two halves are the same process, so there is no API key or internal URL
between them to get wrong.

## Setup

```bash
cp .env.example .env
nano .env                       # XTREAM_URL, PUBLIC_URL, CONFIG_SECRET, AIOSTREAMS_*
cp config/addons.example.json config/addons.json
nano config/addons.json         # your Xperience manifest URL
docker compose up -d --build
```

`CONFIG_SECRET`: `openssl rand -hex 32`. Set it once — changing it invalidates
every manifest link already issued.

Then:

- admin page `http://<host>:7000/` (the root redirects to `/admin/`)
- addon manifest `https://redirect.kohnor.ca/manifest.json`

## Using it

1. Open the admin page and sign in with the **Nuvio** account.
2. Pick the profiles and the stream quality.
3. Tick **Live TV**, enter the **IPTV** username and password, press
   **Check login**. It shows the expiry date and how many screens the plan
   allows.
4. **Preview changes** — read what it will remove — then push.
5. Fully close and reopen Nuvio. Collections are cached per profile.

A failed IPTV login aborts the whole push: nothing is written.

## The layout

The addon adds **no rows of its own**. Everything lives in the **Live TV**
collection: one row of wide category tiles, and opening a category gives a grid
of its channels — square station logos, showing what is on now and next.

Set `COLLECTION_ONLY=false` for the alternative, where the addon contributes a
row per category instead (see `CATEGORY_CATALOGS` and `FOLDERS` in the addon
reference below).

## The addon id is fixed, and must stay that way

A pushed collection names the addon by its manifest id. The id used to be
derived from the configuration, so changing `EXCLUDE_GROUPS`, the panel URL or
anything else renamed the addon and orphaned every collection already pushed:
the player loaded the manifest, found no addon matching the folders, and never
requested a catalog — a row of placeholders that never fill in, with no error
anywhere.

The id is now `community.iptv.live.main` and does not change. `ADDON_ID` can
override the last part if you deliberately want a second, separate addon; a
collection pushed against one id will not work with another, so re-push after
changing it.

The push checks this: if the collection's folders and the installed manifest
disagree, the push log says so rather than leaving you to find out on a TV.

## Seeing what a device actually requests

Every request is logged: status, milliseconds, path and client. Requests taking
over three seconds are marked `SLOW`. The config token is redacted, since it
carries the user's credentials.

```bash
docker compose logs -f | grep '\[req\]'
```

Open the app on the device that misbehaves and watch. This distinguishes the
three cases that look identical on screen:

| What the log shows | What it means |
| --- | --- |
| no lines at all | the device never reached this server — DNS, tunnel, or the app cached a failure |
| `200` on the catalog, nothing for images | the grid loaded and the image requests were never made — the client rejected the URLs |
| `200` on images too | the server did its job; the client is not displaying what it was given |
| `SLOW`, or 5xx | this server is the problem, and the line says which route |

Set `ACCESS_LOG=false` to turn it off.

## Image URLs are deliberately plain

Every image the player fetches — channel logos, backdrops, category tiles —
uses a path with no query string and nothing percent-encoded:

```
/logo/<token>/<hex>.png
/backdrop/<token>/<hex>.png
/tile/<hex>.webp
```

Channel ids start `iptv:`, so building image URLs from them produced
`/logo/iptv%3Acnn-x101.png?v=abc`. Desktop and iOS fetch that happily;
**Android's image loader does not**, which is why logos were missing there and
nowhere else. The cache token moved into the path so changing a logo still
refetches. The older URL shape still works, for clients that cached it.

## Why a category used to sit on blank placeholders

Two things made a TV show a row of empty boxes that never filled in, where a
phone would eventually get there:

**A cold cache after a restart.** Nothing preloaded per-user logins, so the
first request downloaded the whole playlist and guide while the player waited.
Logins are now remembered in `CACHE_DIR` (`/app/cache`) and loaded at startup,
so the first request is served from memory. The startup log says
`[warm] preloading N saved login(s)`.

**Slow logo hosts.** A grid asks for every logo at once, and only the first few
thousand are pre-fetched, so the rest each waited on the provider's logo host.
A logo request now waits `LOGO_DEADLINE_MS` (1500 ms) at most, then serves the
channel's initials and keeps fetching in the background so the real logo is
ready next time. Once a host misses that deadline it is marked slow for a
minute and the rest of the grid skips the wait entirely — a row of 12 channels
behind a dead logo host went from never finishing to 1.7 seconds.

## Payload size

Responses are gzipped, and a catalog page is 50 items (`PAGE_SIZE`). A category
of 300 channels went from 21 kB per page uncompressed to 1.9 kB — which matters
most on a TV, where both the download and the JSON parse are slower than on a
desktop.

## Keeping up with the playlist

The playlist is reloaded every `REFRESH_HOURS` (3 by default) on a timer, not
only when someone asks for it — so a device opening the collection never waits
for a three-hour-old playlist to download. New categories, renamed ones and
changed channel counts all follow automatically, and the tiles are redrawn as
part of the same refresh.

Tile URLs are derived from the category name, so they survive a refresh and you
do not need to push the collection again. Push again only when categories are
added or removed, since the collection's folder list is fixed at push time.

## Saved channels survive playlist changes

A channel's id is built from its name and the provider's stream id
(`iptv:cnn-x101`). When the provider renames a channel, renumbers its streams
or renames a category, the next refresh gives it a new id — and anything a
viewer saved under the old one (their library, Continue Watching) used to stop
working.

Two things now stop that:

**The addon follows the change.** Each refresh records every channel's stream
id, guide id, name and category in `CACHE_DIR/ids/`. A channel id that
disappears is matched to the new playlist on those, in that order, and the old
id keeps resolving to it — meta, stream, logo and backdrop alike. A collection
pushed before a category was renamed keeps opening too. A channel that is
really gone still returns 404, rather than some other channel.

**The account is updated.** On every push from the admin page, the profile's
Nuvio library and Continue Watching are checked, and any entry still under an
old id is moved to the current one (name and poster refreshed, date added and
watch position kept). The push log says how many. After that the server keeps
the profile's Nuvio session, sealed with `CONFIG_SECRET`, in
`CACHE_DIR/nuvio-links.json`, and does the same automatically whenever a
playlist refresh changes ids:

```
[ids] 3 channel/category id(s) changed since the last load; old ids now resolve to the new ones
[relink] a@example.com profile 0: Moved 2 library items and 1 Continue Watching entry onto current channel ids
```

If Nuvio rejects the saved session (password changed, signed out everywhere),
it is dropped and the log says so; the next push re-enables it. Set
`LIBRARY_SYNC=false` to keep no sessions and skip the account updates — the
addon still resolves old ids on its own.

## Category tiles

Each category gets a television graphic with its name on the screen and the
channel count underneath, tinted from the category name so each is distinct.

They are drawn in advance, as soon as a playlist finishes loading, so opening
the collection costs a cached read per category rather than an image render —
which is what made it slow on weaker devices. Served as webp with an ETag and
an hour of browser cache, so a revisit is usually a 304.

Emoji are stripped from both the artwork and the tile label: provider category
names are full of them and the tile font has no glyphs for them, so they would
render as empty boxes. The category's real name is still used for matching, so
nothing breaks.

## Blank category tiles — isolating the cause

If tiles render as empty boxes with only the name, find out which half is at
fault before changing anything else. Point every tile at an image that is known
to render in the app:

```
TILE_TEST_URL=https://cdn.xperience-app.com/covers/default/streaming_services.netflix.webp?v=7
```

Rebuild, push again, restart the app.

- **That artwork appears** → the folder object is fine and the problem is this
  server's image URL or its response. Compare what the app fetches against a
  working cover.
- **Still blank** → the folder object is being rejected, not the image. The
  artwork fields are not the thing to change.

Remove the line once you know.

## Blank category tiles

The tiles are PNGs served by this server at the address in `PUBLIC_URL`, so if
that address does not resolve from the device running Nuvio, every tile renders
as an empty box. The category name is always drawn by the player as well, so a
blank tile *with* a name means only the artwork failed; a blank tile with *no*
name means the collection predates this build — push it again.

Check a tile loads from outside the server:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$(curl -s https://redirect.kohnor.ca/<token>/collection.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["collection"]["folders"][0]["coverImageUrl"])')"
```

`200` is good. Anything else means `PUBLIC_URL` or your reverse proxy is the
problem.

Artwork is served as webp from a plain path (`/tile/<id>.webp`) with no query
string and nothing percent-encoded, matching the URL shape other collections
use. If you changed `PUBLIC_URL`, re-push: the stored collection keeps the old
URLs until you do.

Behind Cloudflare Access, check the policy covers `/admin*` only. A policy on
the whole hostname makes every tile (and every manifest) return a login page
instead of the file, which looks exactly like blank artwork.

## Search

Typing a channel name in Nuvio's search finds it, even though the addon shows
no rows. A second catalog (`Live TV channels`) exists purely for search: its
search term is marked required, so it cannot be browsed into and adds no row,
but the player can still query it.

It matches on channel name and on what is on now or later today, so searching
a programme title finds the channel showing it. Set `SEARCHABLE=false` to turn
it off, or `SEARCH_CATALOG_NAME` to change the heading shown above results.

## Checking it

```bash
curl -s http://localhost:7000/debug.json     # version, rows, settings
docker compose logs --tail=40
```

Startup should say:

```
version     2.0.0
rows        none — collection-only mode (push the Live TV collection to Nuvio)
```

A row named "Live" in Nuvio ("Live - TV") means `COLLECTION_ONLY` is off and
`SHOW_ALL_CHANNELS` is on.

## Without the admin page

For a single account:

```bash
docker compose exec nuvio-livetv node scripts/push-collection.mjs \
  --manifest 'https://redirect.kohnor.ca/<token>/manifest.json' \
  --email you@example.com --password 'nuvio-password' --dry-run
```

Drop `--dry-run` to write.

## Settings

Everything lives in `.env`.

| Variable | Default | What it does |
| --- | --- | --- |
| `XTREAM_URL` | — | The panel. The only one this server will talk to. |
| `XTREAM_USERNAME` / `XTREAM_PASSWORD` | — | A login baked in for yourself. Leave blank when each user gets their own link. |
| `XTREAM_OUTPUT` | `ts` | `ts` or `m3u8`. Try `m3u8` if a channel will not play. |
| `PUBLIC_URL` | — | The address players reach. Links and tile images are built from it. |
| `CONFIG_SECRET` | — | Encrypts each login inside its manifest link. |
| `API_KEY` | — | Turns on `POST /api/manifest` for issuing links from outside. The admin page does not need it. |
| `COLLECTION_ONLY` | `true` | Addon adds no rows; the collection is the whole interface. |
| `AIOSTREAMS_4K_URL` / `AIOSTREAMS_1080P_URL` | — | Offered as the quality choice on the admin page. |
| `EXCLUDE_GROUPS` / `INCLUDE_GROUPS` | `adult,xxx,ppv` | Category filters, matched loosely. |
| `LIBRARY_SYNC` | `true` | Move saved library and Continue Watching entries onto new channel ids after a push and after each refresh. |
| `PORT` | `7000` | Port for both halves. |

More addon settings (logo handling, EPG, tile shape) are listed in
`.env.example`.

## Cautions

- **Pushing replaces a profile's addons and collections** with the configured
  set. Anything else on that profile goes. Preview first.
- **Do not expose `/admin` publicly** without a password in front of it. Anyone
  reaching it can push to any Nuvio account whose login they have. Behind a
  Cloudflare tunnel, put an Access policy on the hostname, or at least on
  `/admin*`, since the root now lands there.
- `config/addons.json` holds your Xperience token and is gitignored.
