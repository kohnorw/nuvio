import crypto from 'node:crypto';
import { formatEpisode } from './epg.js';
import { VERSION } from './manifest.js';
import { imageId } from './xtream.js';
import { lookupArtwork } from './artwork.js';

const timeFmt = new Map();
function clock(ms, cfg) {
  const key = `${cfg.locale}|${cfg.clock24}`;
  let f = timeFmt.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(cfg.locale, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: !cfg.clock24,
    });
    timeFmt.set(key, f);
  }
  return f.format(new Date(ms));
}

function dayLabel(ms, cfg) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return '';
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow ';
  return new Intl.DateTimeFormat(cfg.locale, { weekday: 'short' }).format(d) + ' ';
}

export function nowNext(programmes, now = Date.now()) {
  if (!programmes || !programmes.length) return { current: null, next: null, later: [] };
  let current = null;
  for (const p of programmes) {
    if (p.start <= now && p.stop > now) { current = p; break; }
    if (p.start > now) break;
  }
  const upcoming = programmes.filter((p) => p.start > now);
  return { current, next: upcoming[0] || null, later: upcoming.slice(1, 9) };
}

/**
 * TV fonts on Android TV and Firestick often have no glyph for the block
 * characters U+2588/U+2591, which renders as a row of empty boxes. ASCII is
 * the default for that reason; `blocks` stays available for phone-only setups.
 */
function progress(p, now, cfg) {
  const span = p.stop - p.start;
  if (span <= 0) return '';
  const pct = Math.min(100, Math.max(0, ((now - p.start) / span) * 100));
  const left = Math.max(0, Math.round((p.stop - now) / 60000));
  const remaining = left >= 60
    ? `${Math.floor(left / 60)}h ${left % 60}m left`
    : `${left} min left`;

  if (cfg.progressStyle === 'none') return remaining;

  const filled = Math.round(pct / 10);
  const bar = cfg.progressStyle === 'blocks'
    ? '█'.repeat(filled) + '░'.repeat(10 - filled)
    : '[' + '='.repeat(filled) + '-'.repeat(10 - filled) + ']';
  return `${bar} ${Math.round(pct)}%  ·  ${remaining}`;
}

/**
 * Guides often repeat the title as the first line of the description
 * (Dispatcharr does), and may contain blank lines of their own. Both are
 * removed: the repeat is noise, and a blank line would truncate the rest.
 */
function cleanDescription(desc, title) {
  if (!desc) return '';
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const parts = desc
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (parts.length && title && norm(parts[0]) === norm(title)) parts.shift();
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function programmeLine(p) {
  const ep = formatEpisode(p.episode);
  const bits = [p.title];
  if (ep) bits.push(ep);
  if (p.subTitle && p.subTitle !== p.title) bits.push(`"${p.subTitle}"`);
  return bits.join(' · ');
}

export function shortStatus(ch, cfg, now = Date.now()) {
  const { current, next } = nowNext(ch.programmes, now);
  // Inside a category row the group name is already the heading, so repeating
  // it says nothing. Show what is actually on instead.
  if (!current) return next ? `Next: ${next.title} at ${clock(next.start, cfg)}` : '';
  const line = `Now: ${current.title} · until ${clock(current.stop, cfg)}`;
  return next ? `${line}\nNext: ${next.title} at ${clock(next.start, cfg)}` : line;
}

function placeholder(ch) {
  const label = encodeURIComponent(ch.name.slice(0, 18));
  return `https://placehold.co/500x500/101317/8ea0b5/png?text=${label}`;
}

/**
 * Point the tile at our own normalizer rather than the provider's logo, so
 * every image arrives at the same dimensions and nothing gets cropped.
 * `base` is the addon's own URL, taken from the incoming request.
 */
function posterUrl(ch, cfg, base) {
  // Our own endpoint handles both cases: it normalizes a real logo, and draws
  // a matching tile when the channel has none or the provider's URL is dead.
  if (!cfg.normalizeLogos || !base) return ch.logo || placeholder(ch);

  // Tiles are cached hard by players — a week, by design, since logos rarely
  // change. That means a bad tile would also stick for a week, so the URL
  // carries a token covering the addon version, the source logo, and the
  // tile's shape and colour. Change any of those and the player refetches.
  // Plain path, no query string and nothing percent-encoded. A channel id
  // starts "iptv:", and an encoded colon or a "?v=" is enough for some clients
  // (Android's image loader among them) to skip the image entirely. The cache
  // token lives in the path instead, so changing the logo still refetches.
  const token = crypto
    .createHash('sha1')
    .update(`${VERSION}|${ch.logo}|${cfg.posterShape}|${cfg.tileBackground}`)
    .digest('hex')
    .slice(0, 8);
  return `${base}/logo/${token}/${ch.imageId || imageId(ch.id)}.png`;
}

export function catalogItem(ch, cfg, now = Date.now(), base = '') {
  const { current } = nowNext(ch.programmes, now);
  return {
    id: ch.id,
    type: 'tv',
    name: ch.name,
    poster: posterUrl(ch, cfg, base),
    posterShape: cfg.posterShape,
    logo: ch.logo || undefined,
    description: shortStatus(ch, cfg, now),
    genres: [ch.group].filter(Boolean),
    // A year here, never a title — players print releaseInfo where a year goes.
    releaseInfo: current?.date || undefined,
  };
}

function stationBackdropUrl(ch, cfg, base) {
  if (!base) return ch.logo || undefined;
  const token = crypto
    .createHash('sha1')
    .update(`${VERSION}|${ch.logo}|${cfg.tileBackground}`)
    .digest('hex')
    .slice(0, 8);
  return `${base}/backdrop/${token}/${ch.imageId || imageId(ch.id)}.png`;
}

export async function fullMeta(ch, cfg, now = Date.now(), base = '') {
  const { current, next, later } = nowNext(ch.programmes, now);
  // Look up artwork when the hero needs it, and also whenever the guide gave
  // us no synopsis — a description is worth fetching even in station mode,
  // where the image itself goes unused.
  const needsArt = current
    && (cfg.backgroundSource === 'programme' || !current.desc);
  const art = needsArt ? await lookupArtwork(current.title, cfg) : null;

  // No blank lines anywhere in this block. Players commonly render only the
  // first paragraph of a description, so a blank line silently truncates
  // everything below it — which is how the synopsis kept disappearing.
  const lines = [];

  if (current) {
    // Synopsis sits immediately under the title, so it survives even an
    // aggressive clamp.
    lines.push(programmeLine(current));

    const desc = cleanDescription(current.desc || art?.overview || '', current.title);
    if (desc) lines.push(desc);

    const tags = [];
    if (current.isNew) tags.push('NEW');
    if (current.date) tags.push(current.date);
    if (current.categories.length) tags.push(current.categories.slice(0, 2).join(', '));
    if (current.rating) tags.push(current.rating);
    if (art?.rating) tags.push(`IMDb ${art.rating}`);
    if (current.credits.length) tags.push(current.credits.slice(0, 3).join(', '));
    if (tags.length) lines.push(tags.join('  ·  '));

    const bar = progress(current, now, cfg);
    lines.push(
      `ON NOW  ${clock(current.start, cfg)} – ${clock(current.stop, cfg)}${bar ? `  ·  ${bar}` : ''}`
    );
  } else if (ch.programmes.length) {
    lines.push('LIVE  ·  nothing scheduled in the guide for right now');
  } else {
    lines.push(cfg.epg.length || cfg.xtream ? 'LIVE  ·  no guide data matched this channel' : 'LIVE');
  }

  if (next) {
    lines.push(`NEXT  ${dayLabel(next.start, cfg)}${clock(next.start, cfg)}  ·  ${programmeLine(next)}`);
  }

  for (const p of later) {
    lines.push(`  ${dayLabel(p.start, cfg)}${clock(p.start, cfg)}  ·  ${p.title}`);
  }

  const footer = [ch.group, ch.chno ? `Ch ${ch.chno}` : '', ch.language].filter(Boolean).join('  ·  ');
  if (footer) lines.push(footer);

  // What fills the hero. 'station' builds a backdrop from the channel's own
  // logo, which is stable and always available; 'programme' prefers artwork
  // for whatever is airing and falls back to the station.
  let background;
  if (cfg.backgroundSource === 'none') {
    background = undefined;
  } else if (cfg.backgroundSource === 'programme') {
    background = current?.icon || art?.background || stationBackdropUrl(ch, cfg, base);
  } else {
    background = stationBackdropUrl(ch, cfg, base);
  }

  const genres = [ch.group, ...(current?.categories || [])].filter(Boolean).slice(0, 5);

  // The details panel renders `links` as labelled rows, so the schedule shows
  // up there too rather than only inside a description the player may clamp.
  const links = [];
  for (const g of genres) {
    links.push({ name: g, category: 'Genres', url: `stremio:///discover/tv?genre=${encodeURIComponent(g)}` });
  }
  for (const p of [next, ...later].filter(Boolean).slice(0, cfg.scheduleItems)) {
    links.push({
      name: `${dayLabel(p.start, cfg)}${clock(p.start, cfg)}  ${programmeLine(p)}`,
      category: 'Up next',
      url: `stremio:///search?search=${encodeURIComponent(p.title)}`,
    });
  }
  for (const person of current?.credits || []) {
    links.push({ name: person, category: 'Cast', url: `stremio:///search?search=${encodeURIComponent(person)}` });
  }

  const runtimeMin = current ? Math.round((current.stop - current.start) / 60000) : 0;

  // `defaultVideoId` is what marks this as a single resumable video, which is
  // what a player keys watch progress against. Dropping it is the only lever
  // the addon protocol gives us here.
  const behaviorHints = cfg.hideFromContinueWatching
    ? { hasScheduledVideos: false }
    : { defaultVideoId: ch.id, hasScheduledVideos: false };

  return {
    id: ch.id,
    type: 'tv',
    name: ch.name,
    poster: posterUrl(ch, cfg, base),
    posterShape: cfg.posterShape,
    logo: ch.logo || undefined,
    background,
    description: lines.join('\n').trim(),
    genres,
    links,
    cast: current?.credits?.length ? current.credits.slice(0, 5) : undefined,
    runtime: runtimeMin ? `${runtimeMin} min` : undefined,
    releaseInfo: current?.date || art?.year || undefined,
    country: ch.country || undefined,
    language: ch.language || undefined,
    behaviorHints,
    streams: buildStreams(ch, cfg, now),
  };
}

export function buildStreams(ch, cfg, now = Date.now()) {
  const { current } = nowNext(ch.programmes, now);
  const isHls = /\.m3u8(\?|$)/i.test(ch.url);
  const hasHeaders = Object.keys(ch.headers || {}).length > 0;

  const title = [
    ch.name,
    current ? `${clock(current.start, cfg)} – ${clock(current.stop, cfg)}  ${current.title}` : 'Live',
    ch.group,
  ].filter(Boolean).join('\n');

  const stream = {
    name: `${cfg.name}${isHls ? ' · HLS' : ''}`,
    title,
    url: ch.url,
    behaviorHints: {
      notWebReady: !isHls || hasHeaders,
    },
  };
  // bingeGroup exists to chain episodes together and carries resume behaviour
  // with it; a live channel has nothing to chain to.
  if (!cfg.hideFromContinueWatching) stream.behaviorHints.bingeGroup = `iptv-${ch.group}`;
  if (hasHeaders) stream.behaviorHints.proxyHeaders = { request: ch.headers };
  return [stream];
}

function folderPosterUrl(folder, cfg, base) {
  // Same reasoning as the logo path: no encoded colon, no query string. The
  // tile route already serves this artwork, so reuse it rather than keeping a
  // second URL shape for the same picture.
  return `${base}/tile/${folder.tileId}.webp`;
}

/** A category as a tile in the Categories row. */
export function folderItem(folder, cfg, base = '') {
  return {
    id: folder.id,
    type: 'tv',
    name: folder.name,
    poster: folderPosterUrl(folder, cfg, base),
    posterShape: cfg.posterShape,
    description: `${folder.channels.length} channel${folder.channels.length === 1 ? '' : 's'}`,
  };
}

/**
 * Opening a category shows its channels as a list of videos. Picking one asks
 * the addon for a stream using that channel's id, which is how the folder
 * "opens" into playable channels.
 */
export function folderMeta(folder, cfg, now = Date.now(), base = '') {
  const epoch = Date.UTC(2000, 0, 1);
  const videos = folder.channels.map((ch, i) => {
    const { current } = nowNext(ch.programmes, now);
    return {
      id: ch.id,
      title: ch.name,
      released: new Date(epoch + i * 60000).toISOString(),
      season: 1,
      episode: i + 1,
      thumbnail: posterUrl(ch, cfg, base),
      overview: current ? `${current.title} · until ${clock(current.stop, cfg)}` : undefined,
    };
  });

  return {
    id: folder.id,
    type: 'tv',
    name: folder.name,
    poster: folderPosterUrl(folder, cfg, base),
    posterShape: cfg.posterShape,
    description: `${folder.channels.length} channels in ${folder.name}`,
    genres: [folder.name],
    videos,
    behaviorHints: { hasScheduledVideos: false },
  };
}
