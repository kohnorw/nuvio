import { normalizeKey } from './m3u.js';

// A standardised logo source. iptv-org maintains a public database of channels
// and logos with consistent naming and quality, which is a better basis for a
// tidy channel row than whatever artwork a provider happens to ship.
//
// Matching runs in two passes: the playlist's tvg-id against the database id,
// then the channel name against the database name and alt_names, scoped by
// country so "CTV Life" in Canada doesn't pick up an unrelated US channel.

const BASE = process.env.LOGO_DB_BASE
  || 'https://raw.githubusercontent.com/iptv-org/database/master/data';
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

let db = null;      // { byId, byCountryName, byName, at }
let loading = null;

/**
 * Ids are matched verbatim rather than through normalizeKey, which strips
 * country suffixes — that would let AandE.us match AandE.au. Only case and
 * punctuation are ignored here.
 */
function idKey(id) {
  return String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Minimal CSV reader — the database uses quoted fields with embedded commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift() || [];
  return rows
    .filter((r) => r.length >= header.length - 1 && r.some(Boolean))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

async function fetchCsv(name, userAgent) {
  const res = await fetch(`${BASE}/${name}`, {
    headers: { 'User-Agent': userAgent },
    redirect: 'follow',
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return parseCsv(await res.text());
}

// Prefer a logo that's in use, a real raster format, and big enough to scale
// down cleanly, but not a huge file. Squarer artwork suits a channel tile.
function scoreLogo(l) {
  const w = Number(l.width) || 0;
  const h = Number(l.height) || 0;
  let score = 0;
  if (String(l.in_use).toUpperCase() === 'TRUE') score += 1000;
  if (/^(PNG|SVG|WEBP)$/i.test(l.format)) score += 200;
  if (w >= 200 && w <= 1200) score += 100;
  if (h >= 100) score += 50;
  const ratio = w && h ? Math.max(w, h) / Math.min(w, h) : 9;
  score += Math.max(0, 60 - ratio * 12); // gently favour squarer artwork
  if (!l.feed) score += 25;              // the main feed over regional variants
  return score;
}

export async function loadLogoDatabase(cfg) {
  if (db && Date.now() - db.at < REFRESH_MS) return db;
  if (loading) return loading;

  loading = (async () => {
    const [logos, channels] = await Promise.all([
      fetchCsv('logos.csv', cfg.userAgent),
      fetchCsv('channels.csv', cfg.userAgent),
    ]);

    // Best logo per channel id.
    const best = new Map();
    for (const l of logos) {
      if (!l.channel || !l.url) continue;
      const prev = best.get(l.channel);
      if (!prev || scoreLogo(l) > scoreLogo(prev)) best.set(l.channel, l);
    }

    const byId = new Map();
    const byCountryName = new Map();
    const byName = new Map(); // key -> [{ country, url }], several countries share a name

    for (const ch of channels) {
      if (ch.closed) continue;
      const logo = best.get(ch.id);
      if (!logo) continue;

      const key = idKey(ch.id);
      if (key && !byId.has(key)) byId.set(key, logo.url);

      const country = (ch.country || '').toUpperCase();
      const names = [ch.name, ...(ch.alt_names ? ch.alt_names.split(';') : [])];
      for (const raw of names) {
        const key = normalizeKey(raw);
        if (!key) continue;
        const ck = `${country}|${key}`;
        if (!byCountryName.has(ck)) byCountryName.set(ck, logo.url);
        const list = byName.get(key) || [];
        if (!list.some((e) => e.country === country)) list.push({ country, url: logo.url });
        byName.set(key, list);
      }
    }

    db = { byId, byCountryName, byName, at: Date.now(), size: best.size };
    console.log(
      `[logodb] ${db.size} logos indexed from iptv-org (${byId.size} ids, ${byName.size} names)`
    );
    return db;
  })().finally(() => { loading = null; });

  return loading;
}

/** Country hint from tvg-country, or a "CA | Entertainment" style group name. */
function countryOf(ch) {
  if (ch.country) return ch.country.toUpperCase().slice(0, 2);
  const m = /^\s*([A-Z]{2})\s*[|:.\-]/.exec(ch.group || '') || /^\s*([A-Z]{2})\s*[|:]/.exec(ch.name || '');
  return m ? m[1] : '';
}

/** Strips a "CA: " or "CA | " prefix so the name matches the database's. */
function bareName(name) {
  return String(name || '').replace(/^\s*[A-Z]{2}\s*[|:]\s*/, '');
}

export function findLogo(ch, database, cfg) {
  if (!database) return null;
  const country = countryOf(ch);

  if (ch.tvgId) {
    const exact = database.byId.get(idKey(ch.tvgId));
    if (exact) return exact;
  }

  const nameKey = normalizeKey(bareName(ch.name));
  if (nameKey) {
    if (country) {
      const hit = database.byCountryName.get(`${country}|${nameKey}`);
      if (hit) return hit;
    }
    // A name like "A&E" exists in several countries. Prefer the channel's own
    // country, then the big English-language feeds, rather than whichever row
    // the database happened to list first.
    const candidates = database.byName.get(nameKey);
    if (candidates && candidates.length) {
      const order = [country, ...(cfg?.logoCountryFallback || ['US', 'CA', 'GB'])].filter(Boolean);
      for (const c of order) {
        const hit = candidates.find((e) => e.country === c);
        if (hit) return hit.url;
      }
      return candidates[0].url;
    }
  }
  return null;
}

/**
 * Applies database logos to a channel list according to `logoSource`:
 *   playlist  — provider artwork only (previous behaviour)
 *   repo      — database artwork, falling back to the provider's
 *   repo-only — database artwork or nothing
 */
export async function applyLogoDatabase(channels, cfg) {
  if (cfg.logoSource === 'playlist') return { matched: 0, replaced: 0, filled: 0 };

  let database;
  try {
    database = await loadLogoDatabase(cfg);
  } catch (err) {
    console.warn('[logodb] unavailable, keeping playlist logos:', err.message);
    return { matched: 0, replaced: 0, filled: 0, error: err.message };
  }

  let replaced = 0;
  let filled = 0;
  for (const ch of channels) {
    const url = findLogo(ch, database, cfg);
    if (url) {
      if (ch.logo) replaced++; else filled++;
      ch.playlistLogo = ch.logo || '';
      ch.logo = url;
    } else if (cfg.logoSource === 'repo-only') {
      ch.playlistLogo = ch.logo || '';
      ch.logo = '';
    }
  }

  const matched = replaced + filled;
  console.log(
    `[logodb] matched ${matched}/${channels.length} channels ` +
      `(${replaced} replaced, ${filled} filled in)`
  );
  return { matched, replaced, filled };
}
