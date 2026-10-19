// Keeps old channel ids working after the playlist changes.
//
// A channel id is built from the channel's name and its stream id
// ("iptv:cnn-x101"), so a provider renaming CNN to "CNN HD", or renumbering
// its streams, gives the same channel a new id on the next refresh. Nuvio
// stores library entries and watch progress by id, so every saved channel
// then pointed at nothing: the meta request 404'd and the tile went blank.
//
// Each refresh records a fingerprint per id (stream id, guide id, name,
// category). An id that has disappeared is matched against the new playlist
// by those fingerprints and remembered as an alias, persisted per login in
// CACHE_DIR, so the old id keeps resolving to the channel it always meant.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeKey } from './m3u.js';

const DIR = path.join(process.env.CACHE_DIR || '/app/cache', 'ids');
// A channel that has been gone this long is not coming back under any name.
const FORGET_AFTER_MS = 90 * 86400000;

function fileFor(key) {
  return path.join(DIR, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json');
}

export async function loadHistory(key) {
  try {
    const raw = JSON.parse(await fs.readFile(fileFor(key), 'utf8'));
    return {
      channels: raw.channels || {},
      aliases: raw.aliases || {},
      folders: raw.folders || {},
      folderAliases: raw.folderAliases || {},
    };
  } catch {
    return { channels: {}, aliases: {}, folders: {}, folderAliases: {} };
  }
}

export async function saveHistory(key, history) {
  try {
    await fs.mkdir(DIR, { recursive: true });
    const file = fileFor(key);
    await fs.writeFile(file + '.tmp', JSON.stringify(history), 'utf8');
    await fs.rename(file + '.tmp', file);
  } catch (err) {
    // Aliases still work for this process; they just will not survive a restart.
    console.warn('[ids] could not save channel history:', err.message);
  }
}

/** The provider's stream id, for ids built from an Xtream login. */
export function streamIdOf(id) {
  const m = /-x(\d+)$/.exec(String(id || ''));
  return m ? m[1] : '';
}

function fingerprint(ch, now) {
  return {
    s: streamIdOf(ch.id),
    t: ch.tvgId || '',
    n: normalizeKey(ch.name),
    g: ch.group || '',
    seen: now,
  };
}

/** Category names with emoji, punctuation and case removed. */
function folderKey(name) {
  return String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** One candidate when exactly one fits; otherwise the one in the same category. */
function pick(list, fp) {
  if (!list || !list.length) return null;
  if (list.length === 1) return list[0];
  const sameName = list.filter((c) => normalizeKey(c.name) === fp.n);
  if (sameName.length === 1) return sameName[0];
  const sameGroup = (sameName.length ? sameName : list).filter((c) => c.group === fp.g);
  return sameGroup.length === 1 ? sameGroup[0] : null;
}

function index(channels, keyOf) {
  const m = new Map();
  for (const c of channels) {
    const k = keyOf(c);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return m;
}

/**
 * Bring `history` up to date with a freshly built playlist. Mutates and
 * returns it, plus `changed`: old id -> new id for every alias that is new or
 * now points somewhere else. That is the list a library needs rewriting for.
 */
export function reconcile(history, channels, folders, now = Date.now()) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const byStream = index(channels, (c) => streamIdOf(c.id));
  const byTvg = index(channels, (c) => c.tvgId);
  const byName = index(channels, (c) => normalizeKey(c.name));

  const changed = new Map();

  for (const c of channels) {
    history.channels[c.id] = fingerprint(c, now);
    // A channel that is back under its own id needs no alias.
    if (history.aliases[c.id]) delete history.aliases[c.id];
  }

  for (const [id, fp] of Object.entries(history.channels)) {
    if (byId.has(id)) continue;

    // Stream id first: same stream, new name is the commonest change. Then the
    // guide id, which providers keep across renames. The name last, since it
    // is the thing most likely to have changed.
    const match =
      (fp.s && pick(byStream.get(fp.s), fp)) ||
      (fp.t && pick(byTvg.get(fp.t), fp)) ||
      (fp.n && pick(byName.get(fp.n), fp)) ||
      null;

    if (match) {
      if (history.aliases[id] !== match.id) changed.set(id, match.id);
      history.aliases[id] = match.id;
      // Follow the channel, so a second change later (renamed, then
      // renumbered) still matches from this id.
      history.channels[id] = { ...fingerprint(match, now) };
    } else {
      // Keep the last alias if there was one: a channel missing from one
      // refresh is usually a provider hiccup, and the next one restores it.
      if (now - (fp.seen || 0) > FORGET_AFTER_MS) {
        delete history.channels[id];
        delete history.aliases[id];
      }
    }
  }

  // Categories: matched by name with emoji and punctuation stripped, which is
  // how a "⚽ Sports" becomes "SPORTS" between refreshes.
  const folderByKey = new Map(folders.map((f) => [folderKey(f.name), f]));
  const folderIds = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    history.folders[f.id] = { k: folderKey(f.name), tile: f.tileId, seen: now };
    delete history.folderAliases[f.id];
  }
  for (const [id, rec] of Object.entries(history.folders)) {
    if (folderIds.has(id)) continue;
    const match = folderByKey.get(rec.k);
    if (match) {
      if (history.folderAliases[id] !== match.id) changed.set(id, match.id);
      history.folderAliases[id] = match.id;
    } else if (now - (rec.seen || 0) > FORGET_AFTER_MS) {
      delete history.folders[id];
      delete history.folderAliases[id];
    }
  }

  return { history, changed };
}
