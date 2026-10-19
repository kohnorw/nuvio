import { parseM3U, filterChannels, normalizeKey } from './m3u.js';
import { loadGuide, attachGuide } from './epg.js';
import { configKey } from './config.js';
import { warmLogos } from './logos.js';
import { applyLogoDatabase } from './logodb.js';
import { loadXtream, xtreamEpgUrl, folderId, tileId, imageId } from './xtream.js';
import { loadHistory, saveHistory, reconcile, streamIdOf } from './ids.js';

const cache = new Map(); // configKey -> { promise, data, loadedAt, refreshing }

async function fetchText(url, userAgent) {
  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function build(cfg) {
  const started = Date.now();
  const warnings = [];

  let channels = [];
  let providerOrder = null; // category order as the Xtream panel lists them
  let xtreamInfo = null;

  if (cfg.xtream) {
    try {
      const x = await loadXtream(cfg.xtream, cfg.userAgent);
      channels = channels.concat(x.channels);
      providerOrder = x.categories;
      xtreamInfo = x.info;
    } catch (err) {
      warnings.push(`Xtream: ${err.message}`);
    }
  }

  for (const url of cfg.m3u) {
    try {
      const text = await fetchText(url, cfg.userAgent);
      channels = channels.concat(parseM3U(text));
    } catch (err) {
      warnings.push(`Playlist ${url}: ${err.message}`);
    }
  }
  channels = filterChannels(channels, cfg);

  // A rejected login or unreachable panel is not data. Throwing here means it
  // is retried on the next request instead of being cached as "0 channels".
  if (!channels.length && cfg.xtream && !cfg.m3u.length) {
    const why = warnings.find((w) => w.startsWith('Xtream:'));
    if (why) throw new Error(why.replace(/^Xtream:\s*/, ''));
  }

  // Drop duplicate ids that came from separate playlists.
  const byId = new Map();
  for (const c of channels) if (!byId.has(c.id)) byId.set(c.id, c);
  channels = [...byId.values()];

  let guideChannels = 0;
  // With an Xtream login and no EPG_URL, the panel's own guide is used.
  const epgUrls = cfg.epg.length ? cfg.epg : cfg.xtream ? [xtreamEpgUrl(cfg.xtream)] : [];
  if (epgUrls.length && channels.length) {
    const wanted = new Set();
    for (const c of channels) for (const k of c.epgKeys) wanted.add(normalizeKey(k));
    wanted.delete('');
    try {
      const guide = await loadGuide(epgUrls, wanted, {
        userAgent: cfg.userAgent,
        offsetHours: cfg.epgOffsetHours,
      });
      warnings.push(...guide.errors.map((e) => `Guide ${e}`));
      guideChannels = attachGuide(channels, guide);
    } catch (err) {
      warnings.push(`Guide: ${err.message}`);
    }
  } else {
    for (const c of channels) c.programmes = [];
  }

  // Swap in standardised artwork before anything is cached or served.
  let logoDb = { matched: 0 };
  try {
    logoDb = await applyLogoDatabase(channels, cfg);
  } catch (err) {
    warnings.push(`Logo database: ${err.message}`);
  }

  const present = new Set(channels.map((c) => c.group));
  let groups;
  if (providerOrder) {
    // Provider order first (it is usually curated), then anything from M3U.
    groups = providerOrder.filter((g) => present.has(g));
    for (const g of [...present].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
      if (!groups.includes(g)) groups.push(g);
    }
  } else {
    groups = [...present].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  channels.sort((a, b) => {
    const an = Number(a.chno) || 0;
    const bn = Number(b.chno) || 0;
    if (an && bn && an !== bn) return an - bn;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  // One folder per category, with its channels already in order.
  const folders = groups.map((name) => ({
    id: folderId(name),
    tileId: tileId(name),
    name,
    channels: channels.filter((c) => c.group === name),
  }));
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const folderByTileId = new Map(folders.map((f) => [f.tileId, f]));

  // Image URLs address channels by this instead of by id: a channel id starts
  // "iptv:", and a percent-encoded colon in an image path is not fetched by
  // every client (Android in particular).
  const channelByImageId = new Map();
  for (const c of channels) {
    c.imageId = imageId(c.id);
    channelByImageId.set(c.imageId, c);
  }

  // Map ids from earlier playlists onto this one, so a channel saved to a
  // library before a rename or renumber still opens.
  const key = configKey(cfg);
  const { history, changed } = reconcile(await loadHistory(key), channels, folders);
  await saveHistory(key, history);

  const byStream = new Map();
  for (const c of channels) {
    const sid = streamIdOf(c.id);
    if (sid && !byStream.has(sid)) byStream.set(sid, c);
  }
  const resolveChannel = (id) => {
    if (!id) return null;
    const direct = byId.get(id);
    if (direct) return direct;
    const alias = history.aliases[id];
    if (alias && byId.has(alias)) return byId.get(alias);
    // An Xtream id whose name part changed before this server kept history:
    // the stream id at the end still names the channel.
    const sid = streamIdOf(id);
    return (sid && byStream.get(sid)) || null;
  };
  const resolveFolder = (id) =>
    folderById.get(id) || folderById.get(history.folderAliases[id]) || null;

  // Posters stored in a library carry the image id of the old channel id, so
  // those keep loading too.
  for (const [oldId, newId] of Object.entries(history.aliases)) {
    const c = byId.get(newId);
    if (c) {
      const iid = imageId(oldId);
      if (!channelByImageId.has(iid)) channelByImageId.set(iid, c);
    }
  }
  for (const [oldId, newId] of Object.entries(history.folderAliases)) {
    const f = folderById.get(newId);
    const tid = history.folders[oldId]?.tile;
    if (f && tid && !folderByTileId.has(tid)) folderByTileId.set(tid, f);
  }

  if (changed.size) {
    console.log(`[ids] ${changed.size} channel/category id(s) changed since the last load; old ids now resolve to the new ones`);
  }

  return {
    channels,
    byId,
    resolveChannel,
    resolveFolder,
    idChanges: changed,
    groups,
    folders,
    folderById,
    folderByTileId,
    channelByImageId,
    xtreamInfo,
    guideChannels,
    logoDb,
    warnings,
    loadedAt: Date.now(),
    loadMs: Date.now() - started,
  };
}

// Hook the server sets, so a finished load can pre-render its category tiles.
let afterLoad = null;
export function onLoaded(fn) { afterLoad = fn; }

// Called when a load renamed channel ids, so saved libraries can follow.
const idListeners = [];
export function onIdsChanged(fn) { idListeners.push(fn); }

function loaded(cfg, data) {
  log(cfg, data);
  if (afterLoad) Promise.resolve(afterLoad(cfg, data)).catch(() => {});
  if (data.idChanges?.size) {
    for (const fn of idListeners) {
      Promise.resolve(fn(cfg, data)).catch((err) => console.warn('[ids] listener failed:', err.message));
    }
  }
}

/**
 * Keeps the playlist fresh without waiting for a request. A device opening the
 * collection should never be the thing that discovers the data is three hours
 * old, because it then waits for the whole playlist to download.
 */
function schedule(key, entry, cfg) {
  if (entry.timer) return;
  // Floor of one minute: low enough to test with, high enough that a typo
  // cannot hammer the provider.
  const every = Math.max(1, cfg.refreshHours * 60) * 60000;
  entry.timer = setInterval(() => {
    if (entry.refreshing) return;
    entry.refreshing = true;
    build(cfg)
      .then((data) => { entry.data = data; loaded(cfg, data); })
      .catch((err) => console.error('[refresh]', err.message))
      .finally(() => { entry.refreshing = false; });
  }, every);
  entry.timer.unref?.();
}

/** Returns cached data immediately; kicks off a background refresh when stale. */
export async function getData(cfg) {
  const key = configKey(cfg);
  let entry = cache.get(key);

  if (!entry) {
    entry = { promise: null, data: null, refreshing: false };
    cache.set(key, entry);
  }

  if (!entry.data) {
    if (!entry.promise) {
      entry.promise = build(cfg)
        .then((data) => {
          entry.data = data;
          entry.promise = null;
          loaded(cfg, data);
          schedule(key, entry, cfg);
          return data;
        })
        .catch((err) => {
          entry.promise = null;
          throw err;
        });
    }
    return entry.promise;
  }

  schedule(key, entry, cfg);
  const age = Date.now() - entry.data.loadedAt;
  if (age > cfg.refreshHours * 3600000 && !entry.refreshing) {
    entry.refreshing = true;
    build(cfg)
      .then((data) => {
        entry.data = data;
        loaded(cfg, data);
      })
      .catch((err) => console.error('[refresh]', err.message))
      .finally(() => { entry.refreshing = false; });
  }

  return entry.data;
}

function log(cfg, data) {
  console.log(
    `[load] ${data.channels.length} channels, ${data.groups.length} groups, ` +
      `${data.guideChannels} with guide data, ${data.loadMs} ms`
  );
  for (const w of data.warnings) console.warn('[warn]', w);

  // Fire and forget; browsing works while this runs.
  if (cfg.normalizeLogos && cfg.warmLogos) {
    warmLogos(data.channels, cfg)
      .then((r) => { data.logoWarm = r; })
      .catch((err) => console.warn('[logos] warm-up failed:', err.message));
  }
}

export function cacheStats() {
  return [...cache.values()].map((e) => ({
    channels: e.data?.channels.length ?? 0,
    guideChannels: e.data?.guideChannels ?? 0,
    loadedAt: e.data ? new Date(e.data.loadedAt).toISOString() : null,
    warnings: e.data?.warnings ?? [],
  }));
}
