import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  signIn,
  getProfiles,
  getAddons,
  getCollections,
  pushAddons,
  pushCollections,
  diffAddons,
} from './nuvio.js';
// In the merged build the addon is the same process, so the Live TV link and
// collection are produced by calling it directly — no HTTP hop, no API key, no
// container-to-container URL to get wrong.
import { createLiveTvLink, liveTvApiConfigured, fetchLiveTvCollection } from './livetv-local.js';
import { relinkNow, rememberProfile, describe, librarySyncEnabled } from './relink.js';
import { remember } from '../src/warm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '..', 'config');


// AIOStreams manifest URLs come from the environment (see .env), so the
// tokens they contain never end up in a committed file or in page source.
const QUALITIES = [
  { id: '4k', label: '4K', url: process.env.AIOSTREAMS_4K_URL || '' },
  { id: '1080p', label: '1080p', url: process.env.AIOSTREAMS_1080P_URL || '' },
];

// Optional Live TV addon, toggled per push from the config page.
//
// Two modes:
//  - Personal login (LIVETV_API_URL + LIVETV_API_KEY set): the customer enters
//    their IPTV username and password, and the addon's API turns those into
//    their own manifest link. LIVETV_URL is not used.
//  - Shared link (API not set): every profile gets the same LIVETV_URL, which
//    carries no login. If LIVETV_URL is not set it is built from PUBLIC_URL
//    (<PUBLIC_URL>/manifest.json).
const LIVE_TV = {
  name: process.env.LIVETV_NAME || 'Live TV',
  url: process.env.LIVETV_URL
    || (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/manifest.json` : ''),
  // Push a Live TV collection too: one folder per category, opening into a
  // square grid of channels. Off leaves the addon's own catalog rows only.
  collection: String(process.env.LIVETV_COLLECTION ?? 'true') === 'true',
  collectionTitle: process.env.LIVETV_COLLECTION_TITLE || 'Live TV',
};

// Fallback if config/layout.json is missing.
const DEFAULT_COLLECTION_ORDER = ['Streaming', 'Genre', 'Live TV'];

const app = express.Router();
app.use(express.json({ limit: '10mb' }));

/* ---------------------------------------------------------------- bundle -- */

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(CONFIG_DIR, file), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

async function exists(file) {
  try {
    await fs.access(path.join(CONFIG_DIR, file));
    return true;
  } catch {
    return false;
  }
}

async function loadBundle() {
  const base = await readJson('addons.json', []);
  const collections = await readJson('collections.json', []);
  const genreCollections = await readJson('collections.genre.json', []);
  const layout = await readJson('layout.json', {});
  return {
    base: Array.isArray(base) ? base : [],
    collections: Array.isArray(collections) ? collections : [],
    genreCollections: Array.isArray(genreCollections) ? genreCollections : [],
    collectionOrder: Array.isArray(layout?.collectionOrder)
      ? layout.collectionOrder
      : DEFAULT_COLLECTION_ORDER,
    addonsFilePresent: await exists('addons.json'),
    genreFilePresent: await exists('collections.genre.json'),
  };
}

function collectionTitle(c) {
  return String(c?.title ?? c?.name ?? '').trim().toLowerCase();
}

/**
 * Put the collections in the order named by config/layout.json — Streaming,
 * then Genre, then Live TV. Anything not named keeps its file order and lands
 * after the named ones. Array.prototype.sort is stable, so ties don't shuffle.
 */
function orderCollections(collections, order) {
  const rank = order.map((t) => String(t).trim().toLowerCase());
  const at = (c) => {
    const i = rank.indexOf(collectionTitle(c));
    return i === -1 ? rank.length : i;
  };
  return [...collections].sort((a, b) => at(a) - at(b));
}

/**
 * The exact collection set a profile should end up with, in display order.
 * The Live TV toggle installs the addon only — it adds no collection, so the
 * channels show up under the addon's own catalog rather than a bundled folder.
 */
function desiredCollections(bundle, liveTvCollection = null) {
  return orderCollections(
    [...bundle.collections, ...bundle.genreCollections, ...(liveTvCollection ? [liveTvCollection] : [])],
    bundle.collectionOrder
  );
}

function quality(id) {
  return QUALITIES.find((q) => q.id === id);
}

/**
 * The exact addon set a profile should end up with: the fixed base set from
 * config/addons.json, plus the AIOStreams build for the chosen quality.
 * `liveTv` is null (off) or { url } — already resolved by resolveLiveTv().
 */
function desiredAddons(base, qualityId, liveTv) {
  const q = quality(qualityId);
  if (!q) throw new Error(`Unknown quality "${qualityId}".`);
  if (!q.url)
    throw new Error(
      `${q.label} is not configured — set AIOSTREAMS_${q.id.toUpperCase()}_URL.`
    );
  const addons = [
    ...base,
    { name: `AIOStreams ${q.label}`, url: q.url, enabled: true },
  ];
  if (liveTv) {
    // Belt and braces. resolveLiveTv() already refuses to return anything
    // unverified, but the Live TV addon carries a customer's credentials in
    // its URL, so installing one that was never accepted by the panel would
    // leave a dead addon on the profile. Never install on an unchecked login.
    if (!liveTv.verified || !liveTv.url) {
      throw new Error('Live TV login was not verified — nothing was installed.');
    }
    addons.push({ name: LIVE_TV.name, url: liveTv.url, enabled: true });
  }
  return addons;
}

/**
 * Turns the request's Live TV choice into { url } or null. In personal-login
 * mode that means asking the addon for this customer's manifest link, which
 * also proves the login works before anything is pushed.
 */
async function resolveLiveTv(enabled, credentials) {
  if (!enabled) return null;

  let url;
  let verified;
  let creds = null;
  let token = '';
  if (liveTvApiConfigured()) {
    // Throws on a bad password, an expired account, or an unreachable panel,
    // which aborts the push before anything is written.
    ({ url, verified, cfg: creds, token } = await createLiveTvLink(credentials));
  } else {
    // Shared-link mode: no per-customer login exists to check, so the
    // configured URL is taken as given.
    if (!LIVE_TV.url) throw new Error('Live TV is not configured — set PUBLIC_URL or LIVETV_URL in .env.');
    url = LIVE_TV.url;
    verified = true;
  }
  if (!verified) throw new Error('Live TV login was not verified — nothing was installed.');

  let collection = null;
  let collectionError = null;
  let collectionWarning = null;
  if (LIVE_TV.collection) {
    let warning;
    ({ collection, error: collectionError, warning } = await fetchLiveTvCollection(
      url, LIVE_TV.collectionTitle, creds
    ));
    if (collectionError) console.warn('[livetv] no collection:', collectionError);
    if (warning) {
      console.warn('[livetv]', warning);
      collectionWarning = warning;
    }
  }
  return { url, verified, token, collection, collectionError, collectionWarning };
}

app.get('/api/bundle', async (req, res) => {
  try {
    const b = await loadBundle();
    const ordered = desiredCollections(b);
    res.json({
      addons: b.base.map((a) => ({ name: a.name })),
      collections: ordered.map((c) => ({
        id: c?.id ?? null,
        name: c?.title ?? c?.name ?? '(unnamed)',
        folders: Array.isArray(c?.folders) ? c.folders.length : 0,
      })),
      collectionsCount: ordered.length,
      collectionOrder: b.collectionOrder,
      addonsFilePresent: b.addonsFilePresent,
      liveTv: {
        // Name and availability only — same reasoning as the quality URLs.
        name: LIVE_TV.name,
        needsLogin: liveTvApiConfigured(),
        configured: liveTvApiConfigured() || Boolean(LIVE_TV.url),
      },
      genreFilePresent: b.genreFilePresent,
      // Only ids and labels — never the URLs, which carry tokens.
      qualities: QUALITIES.map((q) => ({
        id: q.id,
        label: q.label,
        configured: Boolean(q.url),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------------------------------------- diagnostics -- */

// What the server would push, and why. No auth needed — reads config only.
app.get('/api/collections', async (_req, res) => {
  try {
    const b = await loadBundle();
    const ordered = desiredCollections(b);
    res.json({
      configDir: CONFIG_DIR,
      files: {
        'collections.json': { present: true, collections: b.collections.length },
        'collections.genre.json': {
          present: b.genreFilePresent,
          collections: b.genreCollections.length,
        },
      },
      collectionOrder: b.collectionOrder,
      willPush: ordered.map((c) => ({
        title: c?.title ?? c?.name ?? '(unnamed)',
        folders: Array.isArray(c?.folders) ? c.folders.length : 0,
        catalogSources: (c?.folders || []).reduce(
          (n, f) => n + (f?.catalogSources?.length || 0),
          0
        ),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ auth -- */

// The page only ever holds the access token. The refresh token stays here, so
// a push can hand it to the library updater (admin/relink.js), which needs to
// sign in again hours later when a playlist refresh changes channel ids.
// Access tokens last an hour; entries go after two.
const sessions = new Map(); // accessToken -> { refreshToken, userId, email, at }
const SESSION_TTL_MS = 2 * 3600000;

function rememberSession(s) {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of sessions) if (v.at < cutoff) sessions.delete(k);
  sessions.set(s.accessToken, { refreshToken: s.refreshToken, userId: s.userId, email: s.email, at: Date.now() });
}

app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Enter an email and password.' });
  try {
    const session = await signIn(email, password);
    rememberSession(session);
    const profiles = await getProfiles(session.accessToken);
    res.json({ accessToken: session.accessToken, email: session.email, profiles });
  } catch (e) {
    res.status(e.status === 400 ? 401 : e.status || 500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------- live tv -- */

// Lets the page confirm a customer's IPTV login before they push anything.
// Returns account details only — never the manifest link.
app.post('/api/livetv/check', async (req, res) => {
  try {
    const { account } = await createLiveTvLink(req.body || {});
    res.json({ ok: true, account });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* --------------------------------------------------------------- preview -- */

app.post('/api/preview', async (req, res) => {
  const { accessToken, profileId, quality: q, liveTv, liveTvLogin } = req.body || {};
  try {
    const bundle = await loadBundle();
    const lt = await resolveLiveTv(liveTv, liveTvLogin);
    const desired = desiredAddons(bundle.base, q, lt);
    const collections = desiredCollections(bundle, lt?.collection);

    const [existingAddons, existingCollections] = await Promise.all([
      getAddons(accessToken, profileId),
      getCollections(accessToken, profileId),
    ]);

    const d = diffAddons(existingAddons, desired);
    res.json({
      addonsRemoved: d.removed,
      addonsAdded: d.added,
      addonsKept: d.kept,
      finalAddonCount: d.addons.length,
      collectionsRemoved: existingCollections.length,
      finalCollectionCount: collections.length,
      collectionOrder: collections.map((c) => c?.title ?? c?.name ?? '(unnamed)'),
      liveTvFolders: lt?.collection ? lt.collection.folders.length : 0,
      liveTvCollectionError: lt?.collectionError || null,
      liveTvCollectionWarning: lt?.collectionWarning || null,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ----------------------------------------------------------------- apply -- */

app.post('/api/apply', async (req, res) => {
  const { accessToken, profileId, quality: q, liveTv, liveTvLogin } = req.body || {};
  const log = [];
  try {
    const bundle = await loadBundle();
    const lt = await resolveLiveTv(liveTv, liveTvLogin);
    const desired = desiredAddons(bundle.base, q, lt);
    const collections = desiredCollections(bundle, lt?.collection);

    const existingAddons = await getAddons(accessToken, profileId);
    const d = diffAddons(existingAddons, desired);

    // Clean install: both RPCs are full-replace, so pushing the exact desired
    // set is what removes everything that isn't in it.
    await pushAddons(accessToken, profileId, d.addons);
    log.push(
      d.removed.length
        ? `Removed ${d.removed.length} addon(s): ${d.removed.join(', ')}`
        : 'No extra addons to remove'
    );
    log.push(`Installed ${d.addons.length} addon(s)`);

    const existingCollections = await getCollections(accessToken, profileId);
    await pushCollections(accessToken, profileId, collections);
    if (existingCollections.length)
      log.push(`Replaced ${existingCollections.length} collection(s)`);
    if (lt?.collectionError) log.push(`No Live TV collection: ${lt.collectionError}`);
    if (lt?.collectionWarning) log.push(`Warning: ${lt.collectionWarning}`);
    log.push(
      `Set ${collections.length} collection(s): ` +
        collections.map((c) => c?.title ?? c?.name ?? '(unnamed)').join(' → ')
    );

    // Channels saved to the library or sitting in Continue Watching keep the
    // id they had when saved. Move any that the provider has since renamed or
    // renumbered, and keep doing so after future playlist refreshes.
    if (lt && librarySyncEnabled) {
      try {
        log.push(describe(await relinkNow(accessToken, profileId, lt.token)));
        const s = sessions.get(accessToken);
        if (s) await rememberProfile({ ...s, profileId, configToken: lt.token });
        // Preload this login after a restart, so its playlist keeps being
        // refreshed (and ids followed) even before anyone opens the app.
        if (lt.token) await remember(lt.token);
      } catch (err) {
        log.push(`Library not updated: ${err.message}`);
      }
    }

    res.json({ ok: true, log });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, log });
  }
});

/* ---------------------------------------------------------------- static -- */

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

export default app;
