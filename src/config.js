// Configuration comes from two places:
//  1. Environment variables (the docker-native way) -> the default config
//  2. An optional base64url segment in the addon URL, so one container can serve
//     several playlists: http://host:7000/<config>/manifest.json

const splitList = (v) =>
  (v || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

import crypto from 'node:crypto';

// When XTREAM_URL is set in the environment it is the only panel this addon
// will talk to. Links can then carry just a username and password, and nobody
// can point the container at some other host through a crafted link.
const SERVER = (process.env.XTREAM_URL || '').trim();

// Accepts true/1/yes/on in any case, with stray spaces or quotes, because
// these come from hand-edited .env files and web forms.
function flag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().replace(/^["']|["']$/g, '').toLowerCase());
}

function xtreamFrom(o = {}) {
  const url = (SERVER || o.url || '').trim();
  const username = (o.username || '').trim();
  const password = (o.password || '').trim();
  if (!url || !username || !password) return null;
  return { url, username, password, output: (o.output || 'ts').trim() };
}

export const defaults = {
  name: process.env.ADDON_NAME || 'IPTV',
  // The catalog row heading, shown on the home screen. Separate from the addon
  // name, which appears in the addon list.
  catalogName: process.env.CATALOG_NAME || process.env.ADDON_NAME || 'Live',
  // Final part of the addon's manifest id, and the thing a pushed collection
  // points at. Stable by design: only change it if you deliberately want a
  // second, separate addon, and re-push any collections afterwards.
  addonId: (process.env.ADDON_ID || 'main').replace(/[^A-Za-z0-9_-]/g, '') || 'main',
  m3u: splitList(process.env.M3U_URL),
  // Xtream Codes login. When set, channels and categories come from the
  // panel's API instead of (or alongside) an M3U file.
  xtreamServer: SERVER,
  // Bearer token for POST /api/manifest. Unset = the endpoint is off.
  apiKey: process.env.API_KEY || '',
  // Optional. When set, login links are encrypted so the password is not
  // readable in the URL, in proxy access logs, or in the Nuvio account.
  configSecret: process.env.CONFIG_SECRET || '',
  xtream: xtreamFrom({
    url: process.env.XTREAM_URL,
    username: process.env.XTREAM_USERNAME,
    password: process.env.XTREAM_PASSWORD,
    output: process.env.XTREAM_OUTPUT,
  }),
  // Categories as folders: a row of folder tiles, each opening a page that
  // Collection-only: the addon contributes no home rows at all, and the Live
  // TV collection (one row of category tiles, each opening a grid) is the
  // whole interface. This is the default; the settings below are ignored
  // unless it is turned off.
  collectionOnly: flag(process.env.COLLECTION_ONLY, true),
  // A search-only catalog so typing a channel name finds it. It adds no row:
  // a catalog whose search extra is required cannot be browsed into.
  searchable: flag(process.env.SEARCHABLE, true),
  // Diagnostic: point every category tile at this URL instead of the generated
  // artwork. Set it to an image known to render in the app to find out whether
  // the problem is the image or the folder object around it.
  tileTestUrl: (process.env.TILE_TEST_URL || '').trim(),
  searchCatalogName: process.env.SEARCH_CATALOG_NAME || 'Live TV channels',
  // Folder tiles that open a *detail* page (the channels become episodes).
  // Off: a row per category gives the grid view instead, which is what people
  // expect from a channel list.
  folders: flag(process.env.FOLDERS, false),
  // A catalog per category: each becomes its own row named after the category,
  // and opening a row gives a full grid of that category's channels — square
  // logos, with the current programme shown on focus. This is the default.
  categoryCatalogs: flag(process.env.CATEGORY_CATALOGS, true),
  folderCatalogName: process.env.FOLDER_CATALOG_NAME || 'Categories',
  // Title of the Nuvio collection served at /collection.json
  collectionName: process.env.COLLECTION_NAME || 'Live TV',
  // A second row listing every channel flat. Off so the home screen shows
  // categories only; search still works through the folder catalog.
  showAllChannels: flag(process.env.SHOW_ALL_CHANNELS, false),
  epg: splitList(process.env.EPG_URL),
  includeGroups: splitList(process.env.INCLUDE_GROUPS),
  excludeGroups: splitList(process.env.EXCLUDE_GROUPS),
  posterShape: process.env.POSTER_SHAPE || 'square',
  splitGroups: flag(process.env.SPLIT_GROUPS, false),
  maxSplitGroups: num(process.env.MAX_SPLIT_GROUPS, 200),
  refreshHours: num(process.env.REFRESH_HOURS, 3),
  epgOffsetHours: num(process.env.EPG_OFFSET_HOURS, 0),
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  locale: process.env.DISPLAY_LOCALE || 'en-US',
  clock24: String(process.env.TIME_FORMAT || '12') === '24',
  // cinemeta (default, no key needed) | tmdb (needs TMDB_API_KEY) | off
  artwork: (process.env.ARTWORK || 'cinemeta').toLowerCase(),
  // letterbox station logos onto one canvas so tiles are visually consistent
  normalizeLogos: String(process.env.NORMALIZE_LOGOS || 'true') === 'true',
  tileBackground: process.env.TILE_BACKGROUND || '#101317',
  // station (the channel's own logo) | programme (what's on) | none
  backgroundSource: (process.env.BACKGROUND_SOURCE || 'station').toLowerCase(),
  // playlist (default) | repo | repo-only. The iptv-org database is well
  // curated, but many of its logos are hosted on Wikimedia, which refuses
  // server-side fetches — so it is opt-in rather than the default.
  logoSource: (process.env.LOGO_SOURCE || 'playlist').toLowerCase(),
  logoCountryFallback: (process.env.LOGO_COUNTRY_FALLBACK || 'US,CA,GB')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  warmLogos: flag(process.env.WARM_LOGOS, true),
  // How long a logo request may wait on the logo host before the viewer gets
  // initials instead. A grid asks for every logo at once, so this is what
  // stops one slow host leaving a whole row blank. 0 disables the deadline.
  logoDeadlineMs: num(process.env.LOGO_DEADLINE_MS, 1500),
  insecureTls: String(process.env.INSECURE_TLS || 'false') === 'true',
  // keep live channels out of the player's Continue Watching row
  hideFromContinueWatching: String(process.env.HIDE_FROM_CONTINUE_WATCHING || 'true') === 'true',
  // how many upcoming programmes to list
  scheduleItems: num(process.env.SCHEDULE_ITEMS, 5),
  // blocks | ascii | none
  progressStyle: (process.env.PROGRESS_STYLE || 'ascii').toLowerCase(),
  tmdbKey: process.env.TMDB_API_KEY || '',
  tmdbLang: process.env.TMDB_LANGUAGE || 'en-US',
  port: num(process.env.PORT, 7000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
};

const ENC_PREFIX = 'enc-'; // plain base64url JSON always starts "eyJ", so this cannot collide
const encKey = () => crypto.createHash('sha256').update(defaults.configSecret).digest();

export function encodeConfig(cfg) {
  const json = JSON.stringify(cfg);
  if (!defaults.configSecret) return Buffer.from(json, 'utf8').toString('base64url');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function readSegment(segment) {
  if (segment.startsWith(ENC_PREFIX)) {
    if (!defaults.configSecret) throw new Error('encrypted link but no CONFIG_SECRET set');
    const buf = Buffer.from(segment.slice(ENC_PREFIX.length), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  }
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Any JSON value, sealed the same way as a login link: AES-GCM under
 * CONFIG_SECRET when it is set, plain base64url otherwise. Used for data this
 * server keeps on disk that should not be readable there.
 */
export function sealJson(value) {
  return encodeConfig(value);
}

export function openJson(sealed) {
  return readSegment(sealed);
}

export function decodeConfig(segment) {
  const raw = readSegment(segment);
  const cfg = {
    ...defaults,
    name: raw.name || defaults.name,
    catalogName: raw.catalogName || raw.name || defaults.catalogName,
    addonId: raw.addonId || defaults.addonId,
    m3u: Array.isArray(raw.m3u) ? raw.m3u : splitList(raw.m3u),
    xtream: raw.xtream ? xtreamFrom(raw.xtream) : defaults.xtream,
    collectionOnly:
      raw.collectionOnly === undefined ? defaults.collectionOnly : !!raw.collectionOnly,
    searchable: raw.searchable === undefined ? defaults.searchable : !!raw.searchable,
    tileTestUrl: raw.tileTestUrl || defaults.tileTestUrl,
    searchCatalogName: raw.searchCatalogName || defaults.searchCatalogName,
    folders: raw.folders === undefined ? defaults.folders : !!raw.folders,
    categoryCatalogs:
      raw.categoryCatalogs === undefined ? defaults.categoryCatalogs : !!raw.categoryCatalogs,
    folderCatalogName: raw.folderCatalogName || defaults.folderCatalogName,
    collectionName: raw.collectionName || defaults.collectionName,
    showAllChannels:
      raw.showAllChannels === undefined ? defaults.showAllChannels : !!raw.showAllChannels,
    epg: Array.isArray(raw.epg) ? raw.epg : splitList(raw.epg),
    includeGroups: Array.isArray(raw.includeGroups) ? raw.includeGroups : splitList(raw.includeGroups),
    excludeGroups: Array.isArray(raw.excludeGroups) ? raw.excludeGroups : splitList(raw.excludeGroups),
    posterShape: raw.posterShape || defaults.posterShape,
    splitGroups: raw.splitGroups === undefined ? defaults.splitGroups : !!raw.splitGroups,
    artwork: raw.artwork || defaults.artwork,
    progressStyle: raw.progressStyle || defaults.progressStyle,
    scheduleItems: num(raw.scheduleItems, defaults.scheduleItems),
    normalizeLogos:
      raw.normalizeLogos === undefined ? defaults.normalizeLogos : !!raw.normalizeLogos,
    tileBackground: raw.tileBackground || defaults.tileBackground,
    logoSource: raw.logoSource || defaults.logoSource,
    backgroundSource: raw.backgroundSource || defaults.backgroundSource,
    hideFromContinueWatching:
      raw.hideFromContinueWatching === undefined
        ? defaults.hideFromContinueWatching
        : !!raw.hideFromContinueWatching,
    epgOffsetHours: num(raw.epgOffsetHours, defaults.epgOffsetHours),
  };
  if (!cfg.m3u.length && !cfg.xtream) throw new Error('config has no playlist or Xtream login');
  return cfg;
}

// Stable key used to cache parsed playlist + guide data per configuration.
export function configKey(cfg) {
  // The password is part of the key (hashed): two logins must never share a
  // cache entry, and a wrong guess at someone's username must not be able to
  // occupy the slot their real login uses.
  const x = cfg.xtream;
  const pw = x ? crypto.createHash('sha1').update(x.password).digest('hex') : '';
  return JSON.stringify([
    cfg.m3u,
    cfg.epg,
    cfg.includeGroups,
    cfg.excludeGroups,
    x ? [x.url, x.username, x.output, pw] : null,
  ]);
}
