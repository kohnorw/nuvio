// Finds artwork for the programme currently airing, so the channel page shows
// the show's backdrop instead of a stretched station logo.
//
// Default source is Cinemeta — the same metadata addon Nuvio already uses, so
// no API key is needed and the artwork matches the rest of the app. Set
// TMDB_API_KEY to use TMDB instead, which covers more non-English titles.

const CINEMETA = 'https://v3-cinemeta.strem.io';
const TMDB_IMG = 'https://image.tmdb.org/t/p';

const cache = new Map(); // query -> { at, value }
const TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 4000;

// Guide titles carry junk that never matches a catalog: "New: ", "(HD)",
// "Live: ", trailing episode markers.
function candidates(title) {
  const clean = String(title || '')
    .replace(/\((?:HD|SD|CC|R|N|New|Live|Repeat)\)/gi, ' ')
    .replace(/^(?:New|Live|Encore|Premiere)\s*[:!-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const out = [clean];
  // "Live PD: Greatest Shifts" also tries "Live PD"
  const colon = clean.indexOf(':');
  if (colon > 2) out.push(clean.slice(0, colon).trim());
  return [...new Set(out.filter((s) => s.length >= 3))];
}

async function getJson(url, ms = 6000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function fromCinemeta(query) {
  for (const type of ['series', 'movie']) {
    let metas;
    try {
      const json = await getJson(
        `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`
      );
      metas = json.metas || [];
    } catch {
      continue;
    }
    const hit = metas.find(
      (m) => m.name && m.name.toLowerCase() === query.toLowerCase()
    ) || metas[0];
    if (!hit) continue;

    // Catalog entries carry a poster but usually no backdrop; the meta does.
    let background = hit.background || null;
    let overview = hit.description || '';
    if (!background && hit.id) {
      try {
        const full = await getJson(`${CINEMETA}/meta/${type}/${hit.id}.json`);
        background = full.meta?.background || null;
        overview = overview || full.meta?.description || '';
      } catch {
        /* poster-only is still an improvement */
      }
    }
    if (!background && !hit.poster) continue;
    return {
      background,
      poster: hit.poster || null,
      overview,
      rating: hit.imdbRating || '',
      year: (hit.releaseInfo || '').slice(0, 4),
      source: 'cinemeta',
    };
  }
  return null;
}

async function fromTmdb(query, cfg) {
  const url = new URL('https://api.themoviedb.org/3/search/multi');
  url.searchParams.set('api_key', cfg.tmdbKey);
  url.searchParams.set('language', cfg.tmdbLang);
  url.searchParams.set('query', query);
  url.searchParams.set('include_adult', 'false');
  const json = await getJson(url.toString());
  const hit = (json.results || []).find(
    (r) => (r.media_type === 'movie' || r.media_type === 'tv') && (r.backdrop_path || r.poster_path)
  );
  if (!hit) return null;
  return {
    background: hit.backdrop_path ? `${TMDB_IMG}/w1280${hit.backdrop_path}` : null,
    poster: hit.poster_path ? `${TMDB_IMG}/w500${hit.poster_path}` : null,
    overview: hit.overview || '',
    rating: hit.vote_average ? Number(hit.vote_average).toFixed(1) : '',
    year: (hit.release_date || hit.first_air_date || '').slice(0, 4),
    source: 'tmdb',
  };
}

export async function lookupArtwork(title, cfg) {
  if (cfg.artwork === 'off' || !title) return null;

  for (const query of candidates(title)) {
    const key = `${cfg.artwork}|${query.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (hit.value ? TTL_MS : NEGATIVE_TTL_MS)) {
      if (hit.value) return hit.value;
      continue;
    }

    let value = null;
    try {
      value = cfg.artwork === 'tmdb' && cfg.tmdbKey
        ? await fromTmdb(query, cfg)
        : await fromCinemeta(query);
    } catch {
      value = null;
    }

    if (cache.size > MAX_ENTRIES) cache.clear();
    cache.set(key, { at: Date.now(), value });
    if (value) return value;
  }
  return null;
}

export function artworkStats() {
  let hits = 0;
  for (const e of cache.values()) if (e.value) hits++;
  return { lookups: cache.size, matched: hits };
}
