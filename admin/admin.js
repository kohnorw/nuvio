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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '..', 'config');


// AIOStreams manifest URLs come from the environment (see .env), so the
// tokens they contain never end up in a committed file or in page source.
const QUALITIES = [
  { id: '4k', label: '4K', url: process.env.AIOSTREAMS_4K_URL || '' },
  { id: '1080p', label: '1080p', url: process.env.AIOSTREAMS_1080P_URL || '' },
];

// Fallback if config/layout.json is missing.
const DEFAULT_COLLECTION_ORDER = ['Streaming', 'Genres'];

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
 * then Genres. Anything not named keeps its file order and lands
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

/** The exact collection set a profile should end up with, in display order. */
function desiredCollections(bundle) {
  return orderCollections([...bundle.collections, ...bundle.genreCollections], bundle.collectionOrder);
}

function quality(id) {
  return QUALITIES.find((q) => q.id === id);
}

/**
 * The exact addon set a profile should end up with: the fixed base set from
 * config/addons.json, plus the AIOStreams build for the chosen quality.
 */
function desiredAddons(base, qualityId) {
  const q = quality(qualityId);
  if (!q) throw new Error(`Unknown quality "${qualityId}".`);
  if (!q.url)
    throw new Error(
      `${q.label} is not configured — set AIOSTREAMS_${q.id.toUpperCase()}_URL.`
    );
  return [...base, { name: `AIOStreams ${q.label}`, url: q.url, enabled: true }];
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

app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Enter an email and password.' });
  try {
    const session = await signIn(email, password);
    const profiles = await getProfiles(session.accessToken);
    res.json({ accessToken: session.accessToken, email: session.email, profiles });
  } catch (e) {
    res.status(e.status === 400 ? 401 : e.status || 500).json({ error: e.message });
  }
});

/* --------------------------------------------------------------- preview -- */

app.post('/api/preview', async (req, res) => {
  const { accessToken, profileId, quality: q } = req.body || {};
  try {
    const bundle = await loadBundle();
    const desired = desiredAddons(bundle.base, q);
    const collections = desiredCollections(bundle);

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
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ----------------------------------------------------------------- apply -- */

app.post('/api/apply', async (req, res) => {
  const { accessToken, profileId, quality: q } = req.body || {};
  const log = [];
  try {
    const bundle = await loadBundle();
    const desired = desiredAddons(bundle.base, q);
    const collections = desiredCollections(bundle);

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
    log.push(
      `Set ${collections.length} collection(s): ` +
        collections.map((c) => c?.title ?? c?.name ?? '(unnamed)').join(' → ')
    );


    res.json({ ok: true, log });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, log });
  }
});

/* ---------------------------------------------------------------- static -- */

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

export default app;
