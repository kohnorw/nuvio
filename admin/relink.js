// Moves saved channels onto their current ids.
//
// The addon resolves old channel ids by itself (src/ids.js), so a library
// entry saved before a rename keeps opening. But the entry in the Nuvio
// account still carries the old id, name and poster, and Continue Watching
// still keys progress by it. This rewrites those rows so the account matches
// the playlist: every library item and watch-progress entry whose id has
// changed is pushed under the new id, then the old row is deleted.
//
// It runs right after a push from the admin page, which also repairs anything
// broken by refreshes before this existed, and again whenever a playlist
// refresh changes ids. For the second case the server keeps each pushed
// profile's Nuvio refresh token (sealed with CONFIG_SECRET) in CACHE_DIR.
// LIBRARY_SYNC=false turns all of this off.
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaults, decodeConfig, configKey, sealJson, openJson } from '../src/config.js';
import { getData, onIdsChanged } from '../src/store.js';
import { catalogItem } from '../src/meta.js';
import {
  refresh,
  pullLibrary,
  pushLibraryItems,
  deleteLibraryItems,
  pullWatchProgress,
  pushWatchProgress,
  deleteWatchProgress,
} from './nuvio.js';

export const librarySyncEnabled = String(process.env.LIBRARY_SYNC ?? 'true') !== 'false';

const DIR = process.env.CACHE_DIR || '/app/cache';
const FILE = path.join(DIR, 'nuvio-links.json');
const MAX_LINKS = 500;

const isOurs = (id) => typeof id === 'string' && id.startsWith('iptv:');

function progressKey(contentId, season, episode) {
  return season != null && episode != null ? `${contentId}_s${season}e${episode}` : contentId;
}

/** The addon's base URL for a login, for poster links in library rows. */
function baseFor(configToken) {
  const root = (defaults.publicUrl || '').replace(/\/+$/, '');
  if (!root) return '';
  return configToken ? `${root}/${configToken}` : root;
}

function cfgFor(configToken) {
  return configToken ? decodeConfig(configToken) : defaults;
}

/**
 * Rewrite one profile. `data` is a loaded playlist (getData). Returns counts;
 * throws on a Nuvio API failure, after which nothing is half-deleted: new rows
 * are always written before old ones are removed.
 */
export async function relinkProfile(accessToken, profileId, { cfg, data, configToken = '' }) {
  const base = baseFor(configToken);
  const now = Date.now();

  /* ---- library ---- */
  const library = await pullLibrary(accessToken, profileId);
  const present = new Set(library.map((i) => `${i.content_type}\0${i.content_id}`));
  const libPush = [];
  const libDelete = [];

  for (const item of library) {
    const id = item.content_id;
    if (!isOurs(id)) continue;

    let next = null;
    const folder = data.resolveFolder(id);
    if (folder) {
      if (folder.id !== id) next = { content_id: folder.id, name: folder.name };
    } else {
      const ch = data.resolveChannel(id);
      if (ch && ch.id !== id) {
        const view = catalogItem(ch, cfg, now, base);
        next = {
          content_id: ch.id,
          name: ch.name,
          poster: view.poster || item.poster || null,
          genres: view.genres,
        };
      }
    }
    if (!next) continue;

    // Already saved under the new id (re-added by hand, say): just drop the
    // stale copy.
    if (!present.has(`${item.content_type}\0${next.content_id}`)) {
      libPush.push({
        content_id: next.content_id,
        content_type: item.content_type,
        name: next.name ?? item.name ?? '',
        poster: next.poster ?? item.poster ?? null,
        poster_shape: item.poster_shape || 'POSTER',
        background: item.background ?? null,
        description: item.description ?? null,
        release_info: item.release_info ?? null,
        imdb_rating: item.imdb_rating ?? null,
        genres: next.genres ?? (Array.isArray(item.genres) ? item.genres : []),
        addon_base_url: item.addon_base_url ?? null,
        added_at: Number(item.added_at) || now,
      });
      present.add(`${item.content_type}\0${next.content_id}`);
    }
    libDelete.push({ content_id: id, content_type: item.content_type });
  }

  /* ---- continue watching ---- */
  const progress = await pullWatchProgress(accessToken, profileId);
  const byKey = new Map(progress.map((p) => [p.progress_key, p]));
  const progPush = new Map(); // new key -> entry
  const progDelete = [];
  let progChanged = 0;

  for (const p of progress) {
    if (!isOurs(p.content_id) && !isOurs(p.video_id)) continue;

    // A channel opened from a category folder is stored as the folder (the
    // content) plus the channel (the video, numbered as an episode). A channel
    // opened directly is the channel for both.
    const folder = isOurs(p.content_id) ? data.resolveFolder(p.content_id) : null;
    const ch = isOurs(p.video_id) ? data.resolveChannel(p.video_id) : null;
    const contentCh = !folder && isOurs(p.content_id) ? data.resolveChannel(p.content_id) : null;

    const contentId = folder?.id || contentCh?.id || p.content_id;
    const videoId = ch?.id || (p.video_id === p.content_id ? contentId : p.video_id);
    let season = p.season ?? null;
    let episode = p.episode ?? null;
    if (folder && ch && season != null) {
      const at = folder.channels.findIndex((c) => c.id === ch.id);
      if (at >= 0) episode = at + 1;
    }

    const key = progressKey(contentId, season, episode);
    if (contentId === p.content_id && videoId === p.video_id && key === p.progress_key) continue;
    progChanged++;

    // Keep whichever is newer if the new key already has progress of its own.
    const existing = progPush.get(key) || byKey.get(key);
    const newer = !existing || Number(p.last_watched) > Number(existing.last_watched);
    if (newer) {
      progPush.set(key, {
        content_id: contentId,
        content_type: p.content_type,
        video_id: videoId,
        ...(season != null ? { season } : {}),
        ...(episode != null ? { episode } : {}),
        position: Number(p.position) || 0,
        duration: Number(p.duration) || 0,
        last_watched: Number(p.last_watched) || now,
        progress_key: key,
      });
    }
    if (key !== p.progress_key) progDelete.push(p.progress_key);
  }

  // Write first, delete second: an interruption leaves a duplicate, never a gap.
  if (libPush.length) await pushLibraryItems(accessToken, profileId, libPush);
  if (libDelete.length) await deleteLibraryItems(accessToken, profileId, libDelete);
  if (progPush.size) await pushWatchProgress(accessToken, profileId, [...progPush.values()]);
  const pushedKeys = new Set(progPush.keys());
  const toDelete = [...new Set(progDelete)].filter((k) => !pushedKeys.has(k));
  if (toDelete.length) await deleteWatchProgress(accessToken, profileId, toDelete);

  return { library: libDelete.length, continueWatching: progChanged };
}

/** "Updated 2 library items and 1 Continue Watching entry to current channels" */
export function describe(result) {
  const parts = [];
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  if (result.library) parts.push(n(result.library, 'library item', 'library items'));
  if (result.continueWatching) parts.push(n(result.continueWatching, 'Continue Watching entry', 'Continue Watching entries'));
  return parts.length ? `Moved ${parts.join(' and ')} onto current channel ids` : 'Library and Continue Watching already match the current channels';
}

/* ---------------------------------------------------------- saved links -- */

let writing = Promise.resolve();

async function readLinks() {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => { try { return openJson(s); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read, change, write — one at a time, so a refresh rotating a token and a
 * push adding a profile cannot overwrite each other.
 */
function updateLinks(fn) {
  writing = writing.then(async () => {
    const links = await readLinks();
    const next = (fn(links) || links).slice(0, MAX_LINKS);
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE + '.tmp', JSON.stringify(next.map(sealJson)), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(FILE + '.tmp', FILE);
  }).catch((err) => console.warn('[relink] could not save links:', err.message));
  return writing;
}

/**
 * Remember a pushed profile so later playlist changes can be applied to its
 * library too. One entry per Nuvio account, listing its profiles: they share
 * one session, and Nuvio rotates the refresh token on every use, so each
 * profile holding its own copy would invalidate the others.
 */
export async function rememberProfile({ userId, email, refreshToken, profileId, configToken }) {
  if (!librarySyncEnabled || !refreshToken || !userId) return;
  if (!defaults.configSecret) {
    console.warn('[relink] CONFIG_SECRET is not set — Nuvio sessions for library updates are stored unencrypted');
  }
  await updateLinks((links) => {
    const old = links.find((l) => l.id === userId);
    // The admin page keeps the token it signed in with. If this server has
    // since rotated it, the stored one is the live descendant: keep it.
    const token = old && old.signinToken === refreshToken ? old.refreshToken : refreshToken;
    const profiles = { ...(old?.profiles || {}), [profileId]: configToken || '' };
    return [
      { id: userId, email, refreshToken: token, signinToken: refreshToken, profiles, at: Date.now() },
      ...links.filter((l) => l.id !== userId),
    ];
  });
}

/**
 * Run the rewrite for every remembered profile on this login. Each account is
 * refreshed once (the rotated token is saved), then each of its profiles on
 * this login is rewritten. A revoked session is forgotten: the next push
 * re-adds it.
 */
async function relinkSaved(cfg, data) {
  const key = configKey(cfg);
  const sameLogin = (token) => {
    try { return configKey(cfgFor(token)) === key; } catch { return false; }
  };
  const links = (await readLinks())
    .map((l) => ({ ...l, targets: Object.entries(l.profiles || {}).filter(([, t]) => sameLogin(t)) }))
    .filter((l) => l.targets.length);
  if (!links.length) return;
  console.log(`[relink] channel ids changed — updating ${links.length} Nuvio account(s)`);

  for (const link of links) {
    let session;
    try {
      session = await refresh(link.refreshToken);
    } catch (err) {
      if (err.status === 400 || err.status === 401) {
        console.warn(`[relink] ${link.email}: session expired, forgetting it (push again to re-enable)`);
        await updateLinks((all) => all.filter((l) => l.id !== link.id));
      } else {
        console.warn(`[relink] ${link.email}: ${err.message}`);
      }
      continue;
    }
    await updateLinks((all) => all.map((l) =>
      l.id === link.id ? { ...l, refreshToken: session.refreshToken || l.refreshToken, at: Date.now() } : l
    ));
    for (const [profileId, configToken] of link.targets) {
      try {
        const r = await relinkProfile(session.accessToken, Number(profileId), {
          cfg: cfgFor(configToken), data, configToken,
        });
        console.log(`[relink] ${link.email} profile ${profileId}: ${describe(r)}`);
      } catch (err) {
        console.warn(`[relink] ${link.email} profile ${profileId}: ${err.message}`);
      }
    }
  }
}

// One at a time: two refreshes finishing together must not interleave
// pull-then-write on the same profile.
let queue = Promise.resolve();
if (librarySyncEnabled) {
  onIdsChanged((cfg, data) => {
    queue = queue.then(() => relinkSaved(cfg, data)).catch((err) => console.warn('[relink]', err.message));
    return queue;
  });
}

/** For the push: load the login's playlist and rewrite this profile now. */
export async function relinkNow(accessToken, profileId, configToken) {
  const cfg = cfgFor(configToken);
  const data = await getData(cfg);
  return relinkProfile(accessToken, profileId, { cfg, data, configToken });
}
