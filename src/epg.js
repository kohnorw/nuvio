import sax from 'sax';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { normalizeKey } from './m3u.js';

const PAST_WINDOW_MS = 6 * 60 * 60 * 1000; // keep a little history for "started at"
const FUTURE_WINDOW_MS = 60 * 60 * 60 * 1000; // ~2.5 days ahead
const MAX_PROGRAMMES_PER_CHANNEL = 240;

// XMLTV timestamps look like "20260817203000 +0000" (offset optional).
export function parseXmltvTime(value) {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, off] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  if (off) {
    const sign = off[0] === '-' ? -1 : 1;
    ms -= sign * ((+off.slice(1, 3) * 60 + +off.slice(3, 5)) * 60000);
  }
  return ms;
}

async function openStream(url, userAgent) {
  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = Readable.fromWeb(res.body);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const gz = /\.gz(\?|$)/i.test(url) || type.includes('gzip') || type.includes('x-gzip');
  return gz ? body.pipe(zlib.createGunzip()) : body;
}

/**
 * Parse one or more XMLTV sources.
 * `wanted` is a Set of normalized channel keys; everything else is discarded
 * as it streams past, so a 300 MB guide never lands in memory.
 */
export async function loadGuide(urls, wanted, { userAgent, offsetHours = 0 } = {}) {
  const byKey = new Map(); // normalized key -> { icon, programmes: [] }
  const now = Date.now();
  const minStop = now - PAST_WINDOW_MS;
  const maxStart = now + FUTURE_WINDOW_MS;
  const shift = offsetHours * 3600000;
  const errors = [];

  const bucket = (key) => {
    let b = byKey.get(key);
    if (!b) {
      b = { icon: '', programmes: [] };
      byKey.set(key, b);
    }
    return b;
  };

  for (const url of urls) {
    try {
      await parseSource(url);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }

  for (const b of byKey.values()) {
    b.programmes.sort((a, z) => a.start - z.start);
    if (b.programmes.length > MAX_PROGRAMMES_PER_CHANNEL) {
      b.programmes = b.programmes.slice(0, MAX_PROGRAMMES_PER_CHANNEL);
    }
  }

  return { byKey, errors, builtAt: now };

  async function parseSource(url) {
    const input = await openStream(url, userAgent);
    const parser = sax.createStream(false, { lowercase: true, trim: true });

    let node = null; // 'channel' | 'programme'
    let channel = null;
    let programme = null;
    let tag = '';
    let text = '';
    let parent = '';

    parser.on('opentag', (t) => {
      const name = t.name;
      const at = t.attributes;
      text = '';
      tag = name;

      if (name === 'channel') {
        node = 'channel';
        channel = { keys: [], icon: '' };
        if (at.id) channel.keys.push(normalizeKey(at.id));
        return;
      }
      if (name === 'programme') {
        node = 'programme';
        const start = parseXmltvTime(at.start);
        const stop = parseXmltvTime(at.stop);
        programme = {
          channelKey: normalizeKey(at.channel),
          start: start === null ? null : start + shift,
          stop: stop === null ? null : stop + shift,
          title: '',
          subTitle: '',
          desc: '',
          categories: [],
          icon: '',
          date: '',
          episode: '',
          rating: '',
          credits: [],
          isNew: false,
        };
        return;
      }
      if (name === 'credits') parent = 'credits';
      if (name === 'new' && programme) programme.isNew = true;
      if (name === 'icon' && at.src) {
        if (node === 'channel' && channel && !channel.icon) channel.icon = at.src;
        if (node === 'programme' && programme && !programme.icon) programme.icon = at.src;
      }
      if (name === 'episode-num' && programme) programme._episodeSystem = (at.system || '').toLowerCase();
    });

    parser.on('text', (t) => { text += t; });
    parser.on('cdata', (t) => { text += t; });

    parser.on('closetag', (name) => {
      const value = text.trim();
      text = '';

      if (name === 'channel') {
        if (channel && channel.keys.length) {
          for (const k of channel.keys) {
            if (!k || !wanted.has(k)) continue;
            const b = bucket(k);
            if (!b.icon && channel.icon) b.icon = channel.icon;
          }
        }
        channel = null;
        node = null;
        return;
      }

      if (name === 'programme') {
        if (
          programme &&
          programme.start !== null &&
          wanted.has(programme.channelKey) &&
          (programme.stop === null || programme.stop > minStop) &&
          programme.start < maxStart
        ) {
          if (programme.stop === null) programme.stop = programme.start + 30 * 60000;
          delete programme._episodeSystem;
          bucket(programme.channelKey).programmes.push(programme);
        }
        programme = null;
        node = null;
        parent = '';
        return;
      }

      if (name === 'credits') { parent = ''; return; }
      if (!value) return;

      if (node === 'channel' && channel) {
        if (name === 'display-name') {
          const k = normalizeKey(value);
          if (k && !channel.keys.includes(k)) channel.keys.push(k);
        }
        return;
      }

      if (node === 'programme' && programme) {
        switch (name) {
          case 'title': if (!programme.title) programme.title = value; break;
          case 'sub-title': if (!programme.subTitle) programme.subTitle = value; break;
          case 'desc': if (!programme.desc) programme.desc = value; break;
          case 'category': if (programme.categories.length < 6) programme.categories.push(value); break;
          case 'date': programme.date = value.slice(0, 4); break;
          case 'episode-num': if (!programme.episode) programme.episode = value; break;
          case 'value': if (!programme.rating) programme.rating = value; break;
          case 'actor':
          case 'director':
          case 'presenter':
            if (parent === 'credits' && programme.credits.length < 8) programme.credits.push(value);
            break;
          default: break;
        }
      }
      tag = '';
    });

    // sax's stream is an old-style Stream, so drive it with pipe + events
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        err ? reject(err) : resolve();
      };
      parser.on('end', () => finish());
      parser.on('error', (err) => {
        // Recover from a malformed chunk instead of losing the whole guide.
        console.warn('[guide] parse issue:', err.message);
        parser._parser.error = null;
        parser._parser.resume();
      });
      input.on('error', finish);
      input.pipe(parser);
    });
  }
}

/** Attach guide data to channels, matching on tvg-id first then display name. */
export function attachGuide(channels, guide) {
  let matched = 0;
  for (const ch of channels) {
    for (const raw of ch.epgKeys) {
      const b = guide.byKey.get(normalizeKey(raw));
      if (b && b.programmes.length) {
        ch.programmes = b.programmes;
        if (!ch.logo && b.icon) ch.logo = b.icon;
        matched++;
        break;
      }
    }
    if (!ch.programmes) ch.programmes = [];
  }
  return matched;
}

/** Human-readable episode number: "S03E12" when the guide uses xmltv_ns or onscreen. */
export function formatEpisode(raw) {
  if (!raw) return '';
  const ns = /^\s*(\d+)?\s*(?:\.\s*(\d+)?)?(?:\.\s*(\d+)?)?\s*$/.exec(raw);
  if (ns && (ns[1] || ns[2])) {
    const s = ns[1] !== undefined ? Number(ns[1]) + 1 : null;
    const e = ns[2] !== undefined ? Number(ns[2]) + 1 : null;
    if (s && e) return `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
    if (e) return `E${String(e).padStart(2, '0')}`;
  }
  return raw.length <= 12 ? raw : '';
}
