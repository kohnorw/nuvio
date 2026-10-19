import crypto from 'node:crypto';

const ATTR_RE = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;

export function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(hd|fhd|uhd|sd|4k|1080p?|720p?|raw|backup|us|usa|ca|uk)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// First comma that is not inside a quoted attribute value separates
// the #EXTINF attributes from the display title.
function titleSplit(info) {
  let quoted = false;
  for (let i = 0; i < info.length; i++) {
    const c = info[i];
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) return i;
  }
  return -1;
}

export function parseM3U(text) {
  const lines = String(text).split(/\r?\n/);
  const channels = [];
  const seen = new Set();
  let pending = null;
  let fallbackGroup = null;

  const flush = (url) => {
    if (!pending || !url || url.startsWith('#')) return;
    const a = pending.attrs;
    const tvgId = a['tvg-id'] || '';
    const name = pending.title || a['tvg-name'] || tvgId || 'Unnamed channel';
    const key = tvgId || `${name}|${pending.group}`;
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    const id = `iptv:${slug(name) || 'ch'}-${hash}`;
    if (!seen.has(id)) {
      seen.add(id);
      channels.push({
        id,
        name,
        tvgId,
        // Keys the guide is matched against, best match first.
        epgKeys: [tvgId, a['tvg-name'], name].filter(Boolean),
        logo: a['tvg-logo'] || a['logo'] || '',
        group: pending.group || 'Uncategorized',
        language: a['tvg-language'] || '',
        country: a['tvg-country'] || '',
        chno: a['tvg-chno'] || a['channel-number'] || '',
        url: url.trim(),
        headers: pending.headers,
        drm: pending.drm,
      });
    }
    pending = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const info = line.slice('#EXTINF:'.length);
      const cut = titleSplit(info);
      const attrPart = cut >= 0 ? info.slice(0, cut) : info;
      const title = cut >= 0 ? info.slice(cut + 1).trim() : '';
      const attrs = {};
      let m;
      ATTR_RE.lastIndex = 0;
      while ((m = ATTR_RE.exec(attrPart)) !== null) attrs[m[1].toLowerCase()] = m[2];
      pending = {
        attrs,
        title,
        group: attrs['group-title'] || fallbackGroup || '',
        headers: {},
        drm: null,
      };
    } else if (line.startsWith('#EXTGRP:')) {
      const g = line.slice('#EXTGRP:'.length).trim();
      if (pending) pending.group = pending.group || g;
      else fallbackGroup = g;
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length);
      const eq = opt.indexOf('=');
      if (eq > 0 && pending) {
        const k = opt.slice(0, eq).trim().toLowerCase();
        const v = opt.slice(eq + 1).trim();
        if (k === 'http-user-agent') pending.headers['User-Agent'] = v;
        if (k === 'http-referrer' || k === 'http-referer') pending.headers['Referer'] = v;
        if (k === 'http-origin') pending.headers['Origin'] = v;
      }
    } else if (line.startsWith('#KODIPROP:')) {
      const opt = line.slice('#KODIPROP:'.length);
      const eq = opt.indexOf('=');
      if (eq > 0 && pending) {
        const k = opt.slice(0, eq).trim().toLowerCase();
        const v = opt.slice(eq + 1).trim();
        if (k.includes('license_type')) pending.drm = { ...(pending.drm || {}), type: v };
        if (k.includes('license_key')) pending.drm = { ...(pending.drm || {}), key: v };
        if (k === 'inputstream.adaptive.stream_headers') {
          for (const pair of v.split('&')) {
            const i = pair.indexOf('=');
            if (i > 0) pending.headers[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
          }
        }
      }
    } else if (line.startsWith('#')) {
      continue;
    } else {
      flush(line);
    }
  }

  return channels;
}

export function filterChannels(channels, { includeGroups = [], excludeGroups = [] }) {
  const inc = includeGroups.map((g) => g.toLowerCase());
  const exc = excludeGroups.map((g) => g.toLowerCase());
  return channels.filter((c) => {
    const g = (c.group || '').toLowerCase();
    if (inc.length && !inc.some((p) => g.includes(p))) return false;
    if (exc.length && exc.some((p) => g.includes(p))) return false;
    return true;
  });
}
