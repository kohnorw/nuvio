import express from 'express';
import compression from 'compression';
import crypto from 'node:crypto';
import { defaults, decodeConfig, encodeConfig } from './config.js';
import { checkLogin, folderId } from './xtream.js';
import { getData, onLoaded, cacheStats } from './store.js';
import { remember, warmAll } from './warm.js';
import { buildManifest, groupCatalogId, buildCollection, VERSION } from './manifest.js';
import { catalogItem, fullMeta, buildStreams, folderItem, folderMeta } from './meta.js';
import { artworkStats } from './artwork.js';
import {
  normalizeLogo,
  fetchRawLogo,
  placeholderTile,
  folderTile,
  categoryTile,
  toWebp,
  stationBackdrop,
  logoCacheStats,
} from './logos.js';

// Smaller pages render sooner on a TV, which has far less CPU than a desktop
// and has to decode every tile in the page before showing any of them.
const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 50;

/**
 * Resolve `promise`, but give up waiting after `ms` and reject with `.slow`.
 * The work carries on — `onTimeout` lets the caller keep it warming in the
 * background — because the next request will want it.
 */
// Logo hosts that have just missed the deadline. A grid asks for a hundred
// logos from the same host at once; once one is known to be slow there is no
// sense making the other ninety-nine wait the full deadline to find out.
// Keyed by host, not by URL: every channel has its own logo URL, so keying by
// URL would make the grid wait the full deadline once per channel. It is the
// host that is slow, and they nearly all come from the same one.
const slowHosts = new Map(); // hostname -> expiry
const SLOW_FOR_MS = 60000;

function logoHost(url) {
  try { return new URL(url).host; } catch { return url; }
}

function isSlow(url) {
  const host = logoHost(url);
  const until = slowHosts.get(host);
  if (!until) return false;
  if (Date.now() > until) { slowHosts.delete(host); return false; }
  return true;
}

function markSlow(url) {
  if (slowHosts.size > 500) slowHosts.clear();
  slowHosts.set(logoHost(url), Date.now() + SLOW_FOR_MS);
}

function clearSlow(url) {
  slowHosts.delete(logoHost(url));
}

function withDeadline(promise, ms, onTimeout) {
  if (!ms) return promise;
  let timer;
  const slow = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('slow');
      e.slow = true;
      if (onTimeout) onTimeout();
      reject(e);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, slow]).finally(() => clearTimeout(timer));
}

const app = express();
app.disable('x-powered-by');

// A category of 100 channels is a few hundred kB of JSON, most of it repeated
// field names and guide text. Gzip takes it to a fraction of that, which
// matters most on the devices that were timing out.
app.use(compression());

// One line per request: method, path, status, milliseconds, and the client.
// Without it there is no way to tell whether a device is failing to ask, being
// answered slowly, or being answered with something it will not use.
if (String(process.env.ACCESS_LOG ?? 'true') !== 'false') {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      // The config token carries the user's credentials — encrypted when
      // CONFIG_SECRET is set, plain base64 otherwise. Never log it whole.
      const path = req.originalUrl.replace(/^\/[A-Za-z0-9_-]{20,}/, '/<token>');
      const ua = (req.get('user-agent') || '').slice(0, 40);
      const slow = ms > 3000 ? '  SLOW' : '';
      console.log(`[req] ${res.statusCode} ${String(ms).padStart(5)}ms ${req.method} ${path} "${ua}"${slow}`);
    });
    next();
  });
}

// The admin page (profile picker, Live TV login, push) lives at /admin on the
// same port. It is mounted lazily so a failure there cannot stop the addon
// itself from serving channels.
try {
  const { default: admin } = await import('../admin/admin.js');
  app.use('/admin', admin);

  // Nothing uses the bare root — the addon lives at /manifest.json and below —
  // so send it to the admin page. That makes a plain hostname (a Cloudflare
  // tunnel, say) land somewhere useful instead of on an error.
  app.get('/', (req, res) => res.redirect(302, '/admin/'));

  // The page asks for /styles.css and /app.js as absolute paths. Serving the
  // same directory at the root as well means the markup needs no rewriting,
  // and the page looks identical whether it is reached at /admin or /admin/.
  const { default: expressStatic } = await import('express');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  app.use(expressStatic.static(join(here, '..', 'public'), { index: false }));
} catch (err) {
  console.error('admin page unavailable:', err.message);
}
// Behind Caddy/nginx/Traefik the client address is in X-Forwarded-For; without
// this every caller looks like the proxy and shares one rate-limit bucket.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});


/* ------------------------------------------------------------- provisioning --
 * POST /api/manifest   Authorization: Bearer <API_KEY>
 *   { "username": "...", "password": "...", "output"?: "ts"|"m3u8" }
 * Checks the login against the panel, then returns a personal manifest URL.
 * The panel address is fixed by XTREAM_URL, so callers only supply credentials.
 */
const attempts = new Map(); // ip -> [timestamps]
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  attempts.set(ip, hits);
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (!v.some((t) => now - t < WINDOW_MS)) attempts.delete(k);
  }
  return hits.length > MAX_PER_WINDOW;
}

function keyMatches(header) {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!m || !defaults.apiKey) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(defaults.apiKey).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post('/api/manifest', express.json({ limit: '4kb' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!defaults.apiKey) {
    return res.status(503).json({ error: 'The manifest API is off. Set API_KEY on the addon to enable it.' });
  }
  if (rateLimited(req.ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }
  if (!keyMatches(req.get('authorization'))) {
    return res.status(401).json({ error: 'Missing or wrong API key.' });
  }
  if (!defaults.xtreamServer) {
    return res.status(503).json({ error: 'XTREAM_URL is not set on the addon.' });
  }

  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '').trim();
  const output = req.body?.output === 'm3u8' ? 'm3u8' : (defaults.xtream?.output || 'ts');
  if (!username || !password) {
    return res.status(400).json({ error: 'Enter a username and password.' });
  }
  if (username.length > 100 || password.length > 200) {
    return res.status(400).json({ error: 'Username or password is too long.' });
  }

  try {
    const account = await checkLogin(
      { url: defaults.xtreamServer, username, password, output },
      defaults.userAgent
    );

    // The panel address is deliberately absent: the addon fills it in from
    // XTREAM_URL, so the link stays short and cannot redirect the container.
    const token = encodeConfig({ xtream: { username, password, output } });
    const manifestUrl = `${baseUrl({ cfg: defaults, get: (h) => req.get(h), protocol: req.protocol, baseUrl: '' })}/${token}/manifest.json`;

    return res.json({
      ok: true,
      manifestUrl,
      installUrl: manifestUrl.replace(/^https?:\/\//i, 'stremio://'),
      encrypted: Boolean(defaults.configSecret),
      account,
    });
  } catch (err) {
    const status = { auth: 401, expired: 403, unreachable: 502 }[err.code] || 500;
    return res.status(status).json({
      error: err.code === 'unreachable' ? 'Could not reach the IPTV service. Try again shortly.' : err.message,
      code: err.code || 'error',
    });
  }
});

// Rendered tiles, kept ready so a device never waits for one to be drawn.
const tileCache = new Map(); // name|count -> webp buffer

async function tileWebp(name, count, cfg) {
  const key = `${name}|${count}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const buf = await toWebp(await categoryTile(name, count, cfg));
  if (tileCache.size > 500) tileCache.clear();
  tileCache.set(key, buf);
  return buf;
}

// Draw every category tile as soon as a playlist finishes loading, including
// after a refresh. Opening the collection then costs a few cached reads
// instead of one image render per category.
onLoaded(async (cfg, data) => {
  const folders = data.folders || [];
  if (!folders.length) return;
  const started = Date.now();
  for (const f of folders) {
    try { await tileWebp(f.name, f.channels.length, cfg); } catch { /* keep going */ }
  }
  console.log(`[tiles] ${folders.length} category tiles ready in ${Date.now() - started} ms`);
});

const router = express.Router({ mergeParams: true });

// The same router is mounted twice: at / (env config) and at /<config>/.
// Without a default login, the / mount must not answer paths that belong to a
// /<config>/ link, so it steps aside for anything that is not a known route.
const ROOT_ROUTES = new Set(['manifest.json', 'collection.json', 'debug.json', 'catalog', 'meta', 'stream', 'logo', 'backdrop', 'folder', 'guide']);
router.use((req, res, next) => {
  if (!req.params.cfg && !ROOT_ROUTES.has(req.path.split('/')[1])) return next('router');
  next();
});

// Resolve the config for this request: URL segment first, env second.
router.use((req, res, next) => {
  const seg = req.params.cfg;
  if (!seg) {
    req.cfg = defaults;
    return next();
  }
  try {
    req.cfg = decodeConfig(seg);
    remember(seg);
    next();
  } catch {
    res.status(404).json({ err: 'That configuration link is not valid.' });
  }
});

// Routes that describe the addon rather than serve anyone's channels. These
// must work without a login, otherwise there is no way to check which build is
// running or which rows it serves.
const NO_LOGIN_NEEDED = new Set(['/manifest.json', '/debug.json']);

router.use((req, res, next) => {
  if (NO_LOGIN_NEEDED.has(req.path)) return next();
  if (!req.cfg.m3u.length && !req.cfg.xtream) {
    return res.status(401).json({
      err: defaults.xtreamServer
        ? 'This link has no login in it. Use the personal manifest link you were given.'
        : 'No source configured. Set XTREAM_URL, XTREAM_USERNAME and XTREAM_PASSWORD (or M3U_URL) in the container environment.',
    });
  }
  next();
});

// The address Nuvio reached us on, so generated image URLs point back here.
function baseUrl(req) {
  if (req.cfg.publicUrl) return req.cfg.publicUrl + (req.baseUrl || '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${req.baseUrl || ''}`;
}

// Logo fetching happens per request, so a systemic failure (blocked host,
// no DNS, provider rejecting the container) would otherwise be invisible.
const logoFailures = { count: 0, lastUrl: null, lastError: null, at: null };
let logoFailuresLogged = 0;

function noteLogoFailure(channel, err) {
  logoFailures.count++;
  logoFailures.lastUrl = channel?.logo || null;
  logoFailures.lastError = err.message;
  logoFailures.at = new Date().toISOString();
  // Loud for the first few, then quiet — one line per channel would flood.
  if (logoFailuresLogged < 5) {
    logoFailuresLogged++;
    console.warn(`[logo] ${channel?.name || '?'}: ${err.message} (${channel?.logo || 'no url'})`);
    if (logoFailuresLogged === 5) {
      console.warn('[logo] further logo failures will not be logged; see /health');
    }
  }
}

/**
 * Split on the separators FIRST, then decode each piece. Decoding first turns
 * an encoded "&" inside a value into a real separator, which silently cut
 * category names like "US | News & Politics" in half.
 */
function parseExtra(raw) {
  const out = {};
  if (!raw) return out;
  const dec = (v) => {
    try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; }
  };
  for (const pair of String(raw).split('&')) {
    const i = pair.indexOf('=');
    if (i > 0) out[dec(pair.slice(0, i))] = dec(pair.slice(i + 1));
  }
  // A player that sent the value unencoded would have had it split above.
  // Rebuild it from the whole string so those names still work.
  if (/^genre=/.test(raw) && raw.includes('&')) out.genreRaw = dec(raw.slice('genre='.length));
  return out;
}

router.get('/manifest.json', async (req, res, next) => {
  try {
    let data = null;
    try {
      data = await getData(req.cfg);
    } catch (err) {
      // No login in this link, or the panel is unhappy. Still describe the
      // addon: the catalog list is how anyone checks which build is running,
      // and answering nothing here leaves them with no way to tell.
      if (req.params.cfg) throw err;
      data = { groups: [], channels: [], folders: [] };
    }
    res.json(buildManifest(req.cfg, data));
  } catch (err) { next(err); }
});

// Plainly reports which build is running and the settings that decide the
// rows, so a stale container or a leftover override is obvious at a glance.
router.get('/debug.json', async (req, res) => {
  const cfg = req.cfg;
  let channels = null;
  let groups = null;
  let error = null;
  try {
    const data = await getData(cfg);
    channels = data.channels.length;
    groups = data.groups.length;
  } catch (err) {
    error = err.message;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    version: VERSION,
    rows: buildManifest(cfg, null).catalogs.map((c) => `${c.name} (${c.id})`),
    settings: {
      COLLECTION_ONLY: cfg.collectionOnly,
      FOLDERS: cfg.folders,
      SHOW_ALL_CHANNELS: cfg.showAllChannels,
      CATEGORY_CATALOGS: cfg.categoryCatalogs,
      SPLIT_GROUPS: cfg.splitGroups,
      XTREAM_URL: cfg.xtreamServer || null,
      hasDefaultLogin: Boolean(defaults.xtream),
      linkHasLogin: Boolean(req.params.cfg),
    },
    data: { channels, categories: groups, error },
  });
});

// A ready-made Nuvio collection for this login: one folder per category.
// The provisioner fetches this and pushes it alongside Streaming and Genres.
router.get('/collection.json', async (req, res, next) => {
  try {
    const data = await getData(req.cfg);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      collection: buildCollection(req.cfg, data, {
        title: req.query.title ? String(req.query.title).slice(0, 60) : cfgTitle(req.cfg),
        base: baseUrl(req),
      }),
    });
  } catch (err) { next(err); }
});

function cfgTitle(cfg) {
  return cfg.collectionName || 'Live TV';
}

async function catalog(req, res, next) {
  try {
    const { type, id } = req.params;
    if (type !== 'tv') return res.json({ metas: [] });

    const cfg = req.cfg;
    const data = await getData(cfg);
    const extra = parseExtra(req.params.extra);
    const now = Date.now();

    // The Categories row: one tile per folder.
    if (id === 'iptv_folders') {
      let folders = data.folders;
      if (extra.search) {
        const q = extra.search.toLowerCase();
        // Search the channels too, not just the category names: with the flat
        // row hidden this catalog is the only thing a player can search.
        const matches = (f) =>
          f.name.toLowerCase().includes(q) ||
          f.channels.some((c) => c.name.toLowerCase().includes(q));
        folders = folders.filter(matches);
      }
      const skip = Number(extra.skip) || 0;
      const base = baseUrl(req);
      return res.json({
        metas: folders.slice(skip, skip + PAGE_SIZE).map((f) => folderItem(f, cfg, base)),
      });
    }

    // In collection-only mode these two catalogs are not meant to be browsed:
    // one needs a genre, the other a search term. The manifest says as much,
    // but a player that ignores that would otherwise turn them into rows of
    // every channel, so refuse here as well.
    if (req.cfg.collectionOnly) {
      if (id === 'iptv_channels' && !extra.genre) return res.json({ metas: [] });
      if (id === 'iptv_search' && !extra.search) return res.json({ metas: [] });
    }

    let list = data.channels;

    // The search-only catalog spans every channel; the search filter below
    // does the work.
    if (id !== 'iptv_channels' && id !== 'iptv_search') {
      const group = data.groups.find((g) => groupCatalogId(g) === id);
      if (!group) return res.json({ metas: [] });
      list = list.filter((c) => c.group === group);
    }

    if (extra.genre) {
      const match = (want) => {
        const g = String(want).toLowerCase().trim();
        return data.channels.filter((c) => (c.group || '').toLowerCase().trim() === g);
      };
      let picked = match(extra.genre);
      // Fall back to the unsplit value for players that do not encode "&".
      if (!picked.length && extra.genreRaw) picked = match(extra.genreRaw);
      // A collection folder names its category as it was when pushed. If the
      // provider has since renamed it, follow the rename.
      if (!picked.length) {
        const renamed = data.resolveFolder(folderId(extra.genre))
          || (extra.genreRaw && data.resolveFolder(folderId(extra.genreRaw)));
        if (renamed) picked = renamed.channels;
      }
      list = picked;
    }

    if (extra.search) {
      const q = extra.search.toLowerCase();
      list = list.filter((c) => {
        if (c.name.toLowerCase().includes(q)) return true;
        const { programmes } = c;
        return programmes.some((p) => p.stop > now && p.title.toLowerCase().includes(q));
      });
    }

    const skip = Number(extra.skip) || 0;
    const page = list.slice(skip, skip + PAGE_SIZE);
    const base = baseUrl(req);
    res.json({ metas: page.map((c) => catalogItem(c, cfg, now, base)) });
  } catch (err) { next(err); }
}

router.get('/catalog/:type/:id.json', catalog);
router.get('/catalog/:type/:id/:extra.json', catalog);

// Diagnose a single channel's logo end to end: what the container gets back,
// and what it managed to do with it.
router.get('/logo/:id/debug', async (req, res, next) => {
  try {
    const data = await getData(req.cfg);
    const ch = data.resolveChannel(req.params.id) || data.channels[0];
    if (!ch) return res.status(404).json({ err: 'no channels loaded' });

    const out = { channel: ch.name, logoUrl: ch.logo || null };
    if (!ch.logo) {
      out.result = 'channel has no tvg-logo in the playlist';
      return res.json(out);
    }

    try {
      const probe = await fetch(ch.logo, {
        headers: { 'User-Agent': req.cfg.userAgent, Accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const buf = Buffer.from(await probe.arrayBuffer());
      out.fetch = {
        status: probe.status,
        contentType: probe.headers.get('content-type'),
        bytes: buf.length,
        firstBytes: buf.subarray(0, 8).toString('hex'),
      };
    } catch (err) {
      out.fetch = { error: err.message };
    }

    try {
      const png = await normalizeLogo(ch.logo, req.cfg);
      out.result = 'normalized ok';
      out.tileBytes = png.length;
    } catch (err) {
      out.result = `normalize failed: ${err.message}`;
    }
    res.json(out);
  } catch (err) { next(err); }
});

// What the guide actually gave us for a channel, before any formatting.
// Answers "is the description missing from the XMLTV, or lost on the way out?"
router.get('/guide/:id/debug', async (req, res, next) => {
  try {
    const data = await getData(req.cfg);
    const ch = data.resolveChannel(req.params.id);
    if (!ch) return res.status(404).json({ err: 'channel not found' });

    const now = Date.now();
    const current = ch.programmes.find((p) => p.start <= now && p.stop > now) || null;
    const withDesc = ch.programmes.filter((p) => p.desc).length;

    res.json({
      channel: ch.name,
      tvgId: ch.tvgId,
      programmes: ch.programmes.length,
      programmesWithDescription: withDesc,
      current: current && {
        title: current.title,
        subTitle: current.subTitle,
        desc: current.desc || null,
        descLength: (current.desc || '').length,
        categories: current.categories,
        episode: current.episode,
        date: current.date,
        credits: current.credits,
        icon: current.icon || null,
      },
      note: withDesc === 0 && ch.programmes.length
        ? 'This channel\'s guide carries no <desc> elements; descriptions come from the artwork provider instead.'
        : undefined,
    });
  } catch (err) { next(err); }
});

router.get('/backdrop/:id.png', backdropHandler);

async function backdropHandler(req, res, next) {
  try {
    const data = await getData(req.cfg);
    const ch = findChannel(data, req);
    if (!ch) return res.status(404).end();
    const png = await stationBackdrop(ch.logo, req.cfg, ch.name);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.end(png);
  } catch (err) { next(err); }
}

// Clean image paths: /logo/<token>/<hex>.png, no query string and nothing
// percent-encoded. Some clients (Android's image loader notably) will not
// fetch an image whose path contains an encoded colon, which is what the old
// /logo/iptv%3A....png?v= form produced.
router.get('/logo/:v/:iid.png', (req, res, next) => {
  req.params.id = req.params.iid;
  req.byImageId = true;
  return logoHandler(req, res, next);
});

router.get('/backdrop/:v/:iid.png', (req, res, next) => {
  req.params.id = req.params.iid;
  req.byImageId = true;
  return backdropHandler(req, res, next);
});

function findChannel(data, req) {
  const key = req.params.id;
  return req.byImageId
    ? data.channelByImageId.get(key)
    : data.resolveChannel(key);
}

router.get('/logo/:id.png', logoHandler);

async function logoHandler(req, res, next) {
  let channel = null;
  try {
    const data = await getData(req.cfg);
    channel = findChannel(data, req);
    if (!channel) return res.status(404).end();

    // No logo at all is the only case that gets initials.
    if (!channel.logo) {
      const png = await placeholderTile(channel.name, req.cfg);
      res.setHeader('Content-Type', 'image/png');
      // Short: a channel may gain a logo on the next playlist refresh, and a
      // week-long cache of initials is exactly how this went wrong before.
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(png);
    }

    // Preferred: fitted onto a consistent tile.
    //
    // A grid asks for every logo at once, and only the first few hundred are
    // pre-fetched, so the rest would each wait on the logo host. A TV gives up
    // long before a slow host answers and leaves the row as blank placeholders
    // for good. So this waits only briefly: past that, the viewer gets initials
    // now and the real logo is fetched in the background, ready next time.
    // Known-slow host: initials straight away, and keep fetching in the
    // background so a later request can serve the real logo.
    if (isSlow(channel.logo)) {
      normalizeLogo(channel.logo, req.cfg)
        .then(() => clearSlow(channel.logo))
        .catch((err) => noteLogoFailure(channel, err));
      const png = await placeholderTile(channel.name, req.cfg);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=120');
      return res.end(png);
    }

    try {
      const png = await withDeadline(
        normalizeLogo(channel.logo, req.cfg),
        req.cfg.logoDeadlineMs,
        () => {
          markSlow(channel.logo);
          normalizeLogo(channel.logo, req.cfg)
            .then(() => clearSlow(channel.logo))
            .catch((err) => noteLogoFailure(channel, err));
        }
      );
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.end(png);
    } catch (err) {
      if (err?.slow) {
        const png = await placeholderTile(channel.name, req.cfg);
        res.setHeader('Content-Type', 'image/png');
        // Short, so the real logo replaces these initials once it is cached.
        res.setHeader('Cache-Control', 'public, max-age=120');
        return res.end(png);
      }
      noteLogoFailure(channel, err);
    }

    // Next best: whatever the logo host returned, at whatever size or format.
    // An odd-sized logo showing beats a tidy tile with nothing on it.
    try {
      const raw = await withDeadline(fetchRawLogo(channel.logo, req.cfg), req.cfg.logoDeadlineMs);
      res.setHeader('Content-Type', raw.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.end(raw.buf);
    } catch (err) {
      if (!err?.slow) noteLogoFailure(channel, err);
    }

    // Last: initials, so the tile is never empty. Redirecting to the logo host
    // instead would hand the player the same slow fetch this just avoided.
    const png = await placeholderTile(channel.name, req.cfg);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.end(png);
  } catch (err) {
    if (channel?.logo) return res.redirect(302, channel.logo);
    return next(err);
  }
}

// Category artwork. webp, plain path, long cache: the format and shape of URL
// that collections are known to render.
router.get('/tile/:tid.webp', async (req, res, next) => {
  try {
    const data = await getData(req.cfg);
    const folder = data.folderByTileId.get(req.params.tid);
    if (!folder) {
      console.warn(`[tile] unknown tile id ${req.params.tid} — re-push the collection`);
      return res.status(404).end();
    }
    const webp = await tileWebp(folder.name, folder.channels.length, req.cfg);

    // The URL stays the same as the playlist changes, but the channel count
    // drawn on the tile does not — so this must not be immutable, or a device
    // would show last week's count. An hour of free reuse, then a conditional
    // request that is a 304 (a few hundred bytes) unless the tile really
    // changed.
    const etag = `"${req.params.tid}-${webp.length}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'image/webp');
    if (req.get('if-none-match') === etag) return res.status(304).end();
    return res.end(webp);
  } catch (err) { next(err); }
});

router.get('/folder/:id.png', async (req, res, next) => {
  try {
    const data = await getData(req.cfg);
    const folder = data.resolveFolder(req.params.id);
    if (!folder) {
      console.warn(`[tile] unknown category id ${req.params.id} — collection may predate a category change; re-push it`);
      return res.status(404).end();
    }
    // ?shape=wide is what the Nuvio collection uses: a streaming-style banner
    // rather than the square folder glyph.
    const png =
      req.query.shape === 'wide'
        ? await categoryTile(folder.name, folder.channels.length, req.cfg)
        : await folderTile(folder.name, folder.channels.length, req.cfg);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(png);
  } catch (err) { next(err); }
});

router.get('/meta/:type/:id.json', async (req, res, next) => {
  try {
    const data = await getData(req.cfg);
    const folder = data.resolveFolder(req.params.id);
    if (folder) {
      res.setHeader('Cache-Control', 'public, max-age=30');
      const meta = folderMeta(folder, req.cfg, Date.now(), baseUrl(req));
      return res.json({ meta: { ...meta, id: req.params.id } });
    }
    // Old ids (from before a rename or renumber) resolve to the channel as it
    // is now. The meta keeps the id the player asked for: a library entry or
    // watch progress saved under that id has to find it unchanged in the
    // reply, or the player treats the answer as a different item.
    const ch = data.resolveChannel(req.params.id);
    if (!ch) return res.status(404).json({ err: 'Channel not found' });
    res.setHeader('Cache-Control', 'public, max-age=30');
    const meta = await fullMeta(ch, req.cfg, Date.now(), baseUrl(req));
    if (ch.id !== req.params.id) {
      meta.id = req.params.id;
      if (meta.behaviorHints?.defaultVideoId) meta.behaviorHints.defaultVideoId = req.params.id;
    }
    res.json({ meta });
  } catch (err) { next(err); }
});

router.get('/stream/:type/:id.json', async (req, res, next) => {
  try {
    const data = await getData(req.cfg);
    const ch = data.resolveChannel(req.params.id);
    if (!ch) return res.json({ streams: [] });
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({ streams: buildStreams(ch, req.cfg) });
  } catch (err) { next(err); }
});

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    installs: cacheStats(),
    artwork: artworkStats(),
    logos: { ...logoCacheStats(), failures: logoFailures },
  });
});

app.get('/', (req, res) => res.redirect('/manifest.json'));

// Plain routes first, then the /<config>/ variants.
app.use('/', router);
app.use('/:cfg([A-Za-z0-9_-]+)', router);

app.use((req, res) => res.status(404).json({ err: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ err: err.message });
});

// Some provider logo hosts serve broken or self-signed certificates. Opt-in,
// and scoped to this process only.
if (defaults.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[tls] certificate verification disabled by INSECURE_TLS');
}

app.listen(defaults.port, () => {
  console.log(`IPTV addon listening on :${defaults.port}`);
  console.log(`  manifest    http://localhost:${defaults.port}/manifest.json`);
  console.log(`  health      http://localhost:${defaults.port}/health`);
  if (defaults.m3u.length || defaults.xtream) {
    getData(defaults).catch((err) => console.error('[startup]', err.message));
  } else {
    console.log(
      defaults.xtreamServer
        ? `  panel       ${defaults.xtreamServer} (login comes from each user's manifest link)`
        : '  no XTREAM_URL or M3U_URL set — the addon has nothing to serve'
    );
    // Per-user logins: load the ones we have seen before, so the first request
    // after a restart is served from memory instead of waiting on the panel.
    warmAll(decodeConfig, getData).catch((err) => console.error('[warm]', err.message));
  }
  {
    const rows = buildManifest(defaults, null).catalogs.map((c) => c.name);
    console.log(`  version     ${VERSION}`);
    console.log(
      defaults.collectionOnly
        ? '  rows        none — collection-only mode (push the Live TV collection to Nuvio)'
        : `  rows        ${rows.join(', ')}  (FOLDERS=${defaults.folders} SHOW_ALL_CHANNELS=${defaults.showAllChannels})`
    );
  }
});
