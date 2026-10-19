import crypto from 'node:crypto';

// Xtream Codes speaks a small JSON API at <server>/player_api.php:
//   (no action)              -> user_info + server_info (used to check the login)
//   action=get_live_categories -> [{ category_id, category_name }]
//   action=get_live_streams    -> [{ stream_id, name, stream_icon, epg_channel_id, category_id, ... }]
// Streams play from <server>/live/<user>/<pass>/<stream_id>.<ext>
// and the guide is at <server>/xmltv.php?username=..&password=..
//
// This turns that into the same channel objects the M3U parser produces, so
// logos, guide matching, artwork and the rest of the addon work unchanged.

const TIMEOUT_MS = 90000;

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Accepts http://host:port, with or without a trailing path or /c/ portal suffix. */
export function xtreamBase(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try {
    const parsed = new URL(u);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return u.replace(/\/+$/, '');
  }
}

export function xtreamEpgUrl(x) {
  const base = xtreamBase(x.url);
  return `${base}/xmltv.php?username=${encodeURIComponent(x.username)}&password=${encodeURIComponent(x.password)}`;
}

async function api(x, userAgent, action) {
  const base = xtreamBase(x.url);
  const qs = new URLSearchParams({ username: x.username, password: x.password });
  if (action) qs.set('action', action);
  const res = await fetch(`${base}/player_api.php?${qs}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${action || 'login'}: HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${action || 'login'}: the server did not return JSON (wrong URL, or the panel blocks this client?)`);
  }
}

/**
 * Login only — no channel download. Returns a plain summary, or throws an Error
 * with `.code` of 'auth' (bad login), 'expired', or 'unreachable'.
 */
export async function checkLogin(x, userAgent) {
  let info;
  try {
    info = await api(x, userAgent, null);
  } catch (err) {
    const e = new Error(err.message);
    e.code = 'unreachable';
    throw e;
  }
  const ui = info?.user_info;
  if (!ui || ui.auth === 0 || ui.auth === '0') {
    const e = new Error('That username or password was not accepted.');
    e.code = 'auth';
    throw e;
  }
  const status = String(ui.status || 'Active');
  const expSec = Number(ui.exp_date);
  const expires = Number.isFinite(expSec) && expSec > 0 ? new Date(expSec * 1000).toISOString() : null;
  if (status.toLowerCase() !== 'active' || (expires && Date.parse(expires) < Date.now())) {
    const e = new Error(`This account is ${status.toLowerCase() === 'active' ? 'expired' : status.toLowerCase()}.`);
    e.code = 'expired';
    throw e;
  }
  return {
    username: ui.username || x.username,
    status,
    expires,
    maxConnections: Number(ui.max_connections) || null,
    activeConnections: Number(ui.active_cons) || 0,
  };
}

/**
 * Returns { channels, categories, info }.
 * `categories` is in the provider's own order, which is usually deliberate.
 */
export async function loadXtream(x, userAgent) {
  const info = await api(x, userAgent, null);
  const ui = info?.user_info;
  if (ui && (ui.auth === 0 || ui.auth === '0')) {
    throw new Error('Xtream login was rejected (check username and password)');
  }
  if (ui && ui.status && String(ui.status).toLowerCase() !== 'active') {
    throw new Error(`Xtream account is ${ui.status}`);
  }

  const [cats, streams] = await Promise.all([
    api(x, userAgent, 'get_live_categories'),
    api(x, userAgent, 'get_live_streams'),
  ]);
  if (!Array.isArray(streams)) throw new Error('get_live_streams returned no list');

  const catName = new Map();
  const categories = [];
  for (const c of Array.isArray(cats) ? cats : []) {
    const name = String(c.category_name || '').trim() || 'Uncategorized';
    catName.set(String(c.category_id), name);
    if (!categories.includes(name)) categories.push(name);
  }

  const base = xtreamBase(x.url);
  const ext = (x.output || 'ts').replace(/^\./, '');
  const u = encodeURIComponent(x.username);
  const p = encodeURIComponent(x.password);

  const channels = [];
  for (const s of streams) {
    if (s.stream_id === undefined || s.stream_id === null) continue;
    const name = String(s.name || '').trim() || `Channel ${s.stream_id}`;
    const group = catName.get(String(s.category_id)) || 'Uncategorized';
    const tvgId = String(s.epg_channel_id || '').trim();
    channels.push({
      id: `iptv:${slug(name) || 'ch'}-x${s.stream_id}`,
      name,
      tvgId,
      epgKeys: [tvgId, name].filter(Boolean),
      logo: String(s.stream_icon || '').trim(),
      group,
      language: '',
      country: '',
      chno: '',
      order: Number(s.num) || 0,
      url: `${base}/live/${u}/${p}/${s.stream_id}.${ext}`,
      headers: {},
      drm: null,
    });
    if (!categories.includes(group)) categories.push(group);
  }

  return { channels, categories, info: { user: ui?.username, expires: ui?.exp_date, maxConnections: ui?.max_connections } };
}

export function folderId(name) {
  return 'iptv:cat-' + tileId(name);
}

/**
 * Plain hex, used in tile image URLs. The folder id carries an "iptv:" prefix
 * so the player routes meta requests to this addon, but a colon has to be
 * percent-encoded in a URL and some clients will not fetch artwork from a path
 * containing one. The image URL therefore uses this instead.
 */
export function imageId(channelId) {
  return crypto.createHash('sha1').update(String(channelId)).digest('hex').slice(0, 12);
}

export function tileId(name) {
  return crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 10);
}
