import crypto from 'node:crypto';
import sharp from 'sharp';

// Station logos arrive in every shape a provider felt like: wide wordmarks,
// tall badges, transparent PNGs, 90x90 JPEGs. A player drops each one into a
// fixed tile and crops to fill, which is why some read as zoomed-in fragments.
// Fitting every logo onto one canvas, with padding rather than cropping, is
// the only way to get a row that looks deliberate.

const cache = new Map(); // key -> { at, buf, type }
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1500;
const FETCH_TIMEOUT_MS = 15000;
const MAX_SOURCE_BYTES = 24 * 1024 * 1024;

export function tileSize(cfg) {
  switch (cfg.posterShape) {
    case 'landscape': return { width: 640, height: 360 };
    case 'poster': return { width: 480, height: 720 };
    default: return { width: 480, height: 480 };
  }
}

function parseColor(value) {
  if (!value || value === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return { r: 16, g: 19, b: 23, alpha: 1 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}

function swapScheme(url) {
  return url.startsWith('https://')
    ? 'http://' + url.slice(8)
    : url.startsWith('http://')
      ? 'https://' + url.slice(7)
      : null;
}

async function tryFetch(url, headers) {
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty response');
  if (buf.length > MAX_SOURCE_BYTES) throw new Error('too large');
  return { buf, contentType: res.headers.get('content-type') || '' };
}

/**
 * Logo hosts are inconsistent about what they'll serve to a server: some want
 * a browser user agent, some want a Referer, some only answer on one scheme.
 * Each attempt is cheap and the result is cached for a week, so it's worth
 * exhausting them before falling back.
 */
async function fetchImage(url, cfg) {
  const browserUA = cfg.userAgent;
  let origin = '';
  try { origin = new URL(url).origin + '/'; } catch { /* malformed, let it fail */ }

  const attempts = [
    { url, headers: { 'User-Agent': browserUA, Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8' } },
    { url, headers: { 'User-Agent': browserUA, Accept: '*/*', Referer: origin } },
    { url, headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', Accept: '*/*' } },
  ];
  const alt = swapScheme(url);
  if (alt) attempts.push({ url: alt, headers: { 'User-Agent': browserUA, Accept: '*/*' } });

  let lastError = new Error('no attempt made');
  for (const attempt of attempts) {
    try {
      return await tryFetch(attempt.url, attempt.headers);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * The raw logo bytes, whatever they are. Used when the image can be fetched
 * but not resized — passing the original through means the logo still shows,
 * which beats a placeholder every time.
 */
export async function fetchRawLogo(url, cfg) {
  const { buf, contentType } = await fetchImage(url, cfg);
  const type = /^image\//.test(contentType) ? contentType : sniffType(buf);
  return { buf, contentType: type };
}

/** Content type from the file's own magic bytes, since headers often lie. */
function sniffType(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.includes('57454250')) return 'image/webp';
  if (buf.subarray(0, 200).toString('utf8').trimStart().startsWith('<svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * Returns a PNG of exactly the tile dimensions, logo centred, aspect intact.
 * `padding` leaves breathing room so wordmarks don't run edge to edge.
 */
export async function normalizeLogo(url, cfg) {
  const { width, height } = tileSize(cfg);
  const key = `${url}|${width}x${height}|${cfg.tileBackground}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.buf;

  const { buf: source } = await fetchImage(url, cfg);
  const background = parseColor(cfg.tileBackground);
  const inset = 0.84; // logo occupies 84% of the tile, leaving even margins

  // Scale down to fit the inset box, then pad out to the exact tile size.
  // Resizing twice would scale the logo back up to full bleed and undo it.
  let inner;
  try {
    inner = await sharp(source, { animated: false })
      .resize({
        width: Math.round(width * inset),
        height: Math.round(height * inset),
        fit: 'inside',
        withoutEnlargement: false,
      })
      .toBuffer({ resolveWithObject: true });
  } catch {
    // Usually an error page served with a 200, or a format sharp can't read.
    throw new Error('not a readable image');
  }

  const padX = Math.max(0, width - inner.info.width);
  const padY = Math.max(0, height - inner.info.height);

  let pipeline = sharp(inner.data).extend({
    left: Math.floor(padX / 2),
    right: Math.ceil(padX / 2),
    top: Math.floor(padY / 2),
    bottom: Math.ceil(padY / 2),
    background,
  });

  if (background.alpha === 1) pipeline = pipeline.flatten({ background });

  const buf = await pipeline.png({ compressionLevel: 9 }).toBuffer();

  if (cache.size > MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), buf, kind: 'logo' });
  return buf;
}

/** Initials for a channel with no usable logo: "CA: CTV Life" -> "CL". */
function initials(name) {
  const words = String(name || '')
    .replace(/^[A-Z]{2,3}\s*[:|]\s*/i, '') // drop a "CA:" style country prefix
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'TV';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A tile in the same dimensions and background as a normalized logo, so a
 * channel with a missing or dead logo still lines up with the rest of the row.
 */
export async function placeholderTile(name, cfg) {
  const { width, height } = tileSize(cfg);
  const key = `placeholder|${name}|${width}x${height}|${cfg.tileBackground}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.buf;

  const bg = parseColor(cfg.tileBackground);
  const fill = bg.alpha === 1 ? `rgb(${bg.r},${bg.g},${bg.b})` : '#101317';
  const size = Math.round(Math.min(width, height) * 0.34);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${fill}"/>
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle"
      font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="${size}"
      font-weight="600" fill="#8ea0b5">${initials(name)}</text>
  </svg>`;

  const buf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  if (cache.size > MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), buf, kind: 'placeholder' });
  return buf;
}

/**
 * Pre-fetch logos after a playlist load. Two reasons: tiles are instant on
 * first browse instead of resolving one at a time, and a systemic fetch
 * problem shows up in the log right away rather than as a wall of blank tiles.
 */
export async function warmLogos(channels, cfg, { concurrency = 8, limit = 4000 } = {}) {
  if (!cfg.normalizeLogos) return { ok: 0, failed: 0, skipped: 0 };

  const targets = channels.filter((c) => c.logo).slice(0, limit);
  let ok = 0;
  let failed = 0;
  let firstError = null;
  let index = 0;

  async function worker() {
    while (index < targets.length) {
      const ch = targets[index++];
      try {
        await normalizeLogo(ch.logo, cfg);
        ok++;
      } catch (err) {
        failed++;
        if (!firstError) firstError = `${ch.name}: ${err.message} (${ch.logo})`;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const skipped = channels.length - targets.length;
  if (failed) {
    console.warn(`[logos] ${ok} fetched, ${failed} failed — first failure: ${firstError}`);
  } else if (ok) {
    console.log(`[logos] ${ok} fetched${skipped > 0 ? `, ${skipped} not pre-fetched` : ''}`);
  }
  return { ok, failed, skipped, firstError };
}

/**
 * A 1280x720 backdrop built from the station logo: the logo blown up, blurred
 * and darkened as a wash, with the crisp logo centred on top. Stretching a
 * square logo across a hero is what this replaces — same source, but it reads
 * as deliberate rather than as a mistake.
 */
export async function stationBackdrop(url, cfg, name = '') {
  const width = 1280;
  const height = 720;
  const key = `backdrop|${url || name}|${cfg.tileBackground}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.buf;

  const bg = parseColor(cfg.tileBackground);
  const base = { r: bg.alpha === 1 ? bg.r : 16, g: bg.alpha === 1 ? bg.g : 19, b: bg.alpha === 1 ? bg.b : 23, alpha: 1 };

  const layers = [];
  let logo = null;

  if (url) {
    try {
      const { buf } = await fetchImage(url, cfg);
      logo = buf;
    } catch {
      logo = null;
    }
  }

  if (logo) {
    // Wash: cover the frame, blur heavily, darken so foreground stays legible.
    try {
      const wash = await sharp(logo, { animated: false })
        .resize({ width, height, fit: 'cover', position: 'centre' })
        .blur(48)
        .modulate({ brightness: 0.45, saturation: 0.7 })
        .toBuffer();
      layers.push({ input: wash, blend: 'over' });
    } catch { /* wash is decorative; carry on without it */ }

    // Crisp logo, centred, at a third of the width.
    try {
      const mark = await sharp(logo, { animated: false })
        .resize({
          width: Math.round(width * 0.34),
          height: Math.round(height * 0.34),
          fit: 'inside',
          withoutEnlargement: false,
        })
        .toBuffer();
      layers.push({ input: mark, gravity: 'centre' });
    } catch { /* nothing to place */ }
  }

  const buf = await sharp({
    create: { width, height, channels: 4, background: base },
  })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();

  if (cache.size > MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), buf, kind: 'backdrop' });
  return buf;
}

export function logoCacheStats() {
  // Counting these separately matters: a cache full of placeholders looks
  // identical to a cache full of logos if you only report a total.
  let normalized = 0;
  let placeholder = 0;
  for (const e of cache.values()) {
    if (e.kind === 'placeholder') placeholder++;
    else if (e.kind === 'logo') normalized++;
  }
  return { normalized, placeholder };
}

/**
 * Emoji and other pictographs out of artwork text. Provider category names are
 * full of them, the tile font has no glyphs for them, and they render as empty
 * boxes. Variation selectors and zero-width joiners go too, or they leave
 * stray marks behind.
 */
export function stripEmoji(s) {
  return String(s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Greedy word wrap on character count; long single words are hard-split.
function wrapLabel(name, perLine, maxLines) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (w.length > perLine) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, perLine));
      w = w.slice(perLine);
    }
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= perLine) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, Math.max(1, perLine - 1)) + '…';
    return kept;
  }
  return lines;
}

/**
 * A wide category tile: the name set large on a tinted panel, in the style of
 * a streaming-service row. No folder glyph — these sit in a row of their own
 * where it would only be noise.
 *
 * The tint is derived from the name, so each category keeps the same colour
 * between restarts and neighbouring rows are easy to tell apart.
 */
export async function categoryTile(name, count, cfg) {
  const width = 640;
  const height = 360;
  const key = `cat2|${name}|${count}|${width}x${height}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.buf;

  // Colour derived from the name, so a category keeps the same look between
  // restarts and neighbouring tiles are easy to tell apart.
  const h = crypto.createHash('sha1').update(String(name)).digest();
  const hue = Math.round((h[0] * 360) / 256);
  const hue2 = (hue + 34) % 360;

  const clean = stripEmoji(String(name)).replace(/\s*[|/]\s*/g, ' · ').trim() || String(name).trim();

  // Television: screen, bezel, stand. The name sits on the screen.
  const tvW = 420;
  const tvH = 250;
  const tvX = (width - tvW) / 2;
  const tvY = 34;
  const scrInset = 16;
  const scrW = tvW - scrInset * 2;
  const scrH = tvH - scrInset * 2;

  const fontSize = clean.length > 28 ? 30 : clean.length > 18 ? 36 : 44;
  const perLine = Math.max(8, Math.floor((scrW * 0.86) / (fontSize * 0.55)));
  const lines = wrapLabel(clean, perLine, 3);
  const blockTop =
    tvY + scrInset + scrH / 2 - ((lines.length - 1) * fontSize * 1.14) / 2 + fontSize * 0.34;
  const tspans = lines
    .map((l, i) => `<tspan x="50%" y="${Math.round(blockTop + i * fontSize * 1.14)}">${xmlEscape(l)}</tspan>`)
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue}, 30%, 16%)"/>
        <stop offset="100%" stop-color="hsl(${hue2}, 34%, 8%)"/>
      </linearGradient>
      <linearGradient id="scr" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0%" stop-color="hsl(${hue}, 58%, 46%)"/>
        <stop offset="100%" stop-color="hsl(${hue2}, 62%, 24%)"/>
      </linearGradient>
      <linearGradient id="glare" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.20"/>
        <stop offset="48%" stop-color="#ffffff" stop-opacity="0.05"/>
        <stop offset="49%" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
    </defs>

    <rect width="100%" height="100%" fill="url(#bg)"/>

    <!-- stand -->
    <rect x="${width / 2 - 52}" y="${tvY + tvH - 4}" width="104" height="12" rx="5" fill="#0d0f12" opacity="0.85"/>
    <rect x="${width / 2 - 92}" y="${tvY + tvH + 8}" width="184" height="13" rx="6" fill="#171b20"/>

    <!-- bezel -->
    <rect x="${tvX}" y="${tvY}" width="${tvW}" height="${tvH}" rx="22" fill="#15181d"/>
    <rect x="${tvX + 3}" y="${tvY + 3}" width="${tvW - 6}" height="${tvH - 6}" rx="20"
          fill="none" stroke="#2b3139" stroke-width="2"/>

    <!-- screen -->
    <rect x="${tvX + scrInset}" y="${tvY + scrInset}" width="${scrW}" height="${scrH}" rx="10" fill="url(#scr)"/>
    <rect x="${tvX + scrInset}" y="${tvY + scrInset}" width="${scrW}" height="${scrH}" rx="10" fill="url(#glare)"/>

    <text text-anchor="middle" font-family="DejaVu Sans, Noto Sans, sans-serif"
          font-size="${fontSize}" font-weight="700" fill="#ffffff">${tspans}</text>

    <!-- power light -->
    <circle cx="${tvX + tvW - 26}" cy="${tvY + tvH - 14}" r="4" fill="hsl(${hue}, 80%, 62%)"/>

    <text x="50%" y="${height - 16}" text-anchor="middle"
          font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="22"
          fill="#ffffff" fill-opacity="0.55">${count} channel${count === 1 ? '' : 's'}</text>
  </svg>`;

  const buf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  if (cache.size > MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), buf, kind: 'folder' });
  return buf;
}

/** A folder tile: folder glyph, the category name, and how many channels it holds. */
export async function folderTile(name, count, cfg) {
  const { width, height } = tileSize(cfg);
  const key = `folder|${name}|${count}|${width}x${height}|${cfg.tileBackground}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.buf;

  const bg = parseColor(cfg.tileBackground);
  const fill = bg.alpha === 1 ? `rgb(${bg.r},${bg.g},${bg.b})` : '#101317';

  const unit = Math.min(width, height);
  const fw = unit * 0.56;           // folder width
  const fh = fw * 0.66;             // folder height
  const fx = (width - fw) / 2;
  const fy = height * 0.10;
  const tab = fw * 0.36;
  const r = fw * 0.06;

  const fontSize = Math.round(unit * (name.length > 18 ? 0.075 : 0.09));
  const perLine = Math.max(8, Math.floor((width * 0.86) / (fontSize * 0.58)));
  const lines = wrapLabel(name, perLine, 3);
  const textTop = fy + fh + unit * 0.09 + fontSize;
  const tspans = lines
    .map((l, i) => `<tspan x="50%" y="${Math.round(textTop + i * fontSize * 1.22)}">${xmlEscape(l)}</tspan>`)
    .join('');

  const badgeSize = Math.round(unit * 0.058);
  const badgeY = Math.round(textTop + lines.length * fontSize * 1.22 + badgeSize * 0.6);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${fill}"/>
    <path d="M${fx + r},${fy} h${tab - r} l${fw * 0.07},${fh * 0.13} h${fw - tab - fw * 0.07 - r}
             a${r},${r} 0 0 1 ${r},${r} v${fh - fh * 0.13 - r * 2} a${r},${r} 0 0 1 -${r},${r}
             h-${fw - r * 2} a${r},${r} 0 0 1 -${r},-${r} v-${fh - r * 2} a${r},${r} 0 0 1 ${r},-${r} z"
          fill="#3d6fb4"/>
    <rect x="${fx}" y="${fy + fh * 0.2}" width="${fw}" height="${fh * 0.8}" rx="${r}" fill="#5b93d9"/>
    <text text-anchor="middle" font-family="DejaVu Sans, Noto Sans, sans-serif"
      font-size="${fontSize}" font-weight="700" fill="#e6edf5">${tspans}</text>
    <text x="50%" y="${badgeY}" text-anchor="middle" font-family="DejaVu Sans, Noto Sans, sans-serif"
      font-size="${badgeSize}" fill="#8ea0b5">${count} channel${count === 1 ? '' : 's'}</text>
  </svg>`;

  const buf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  if (cache.size > MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), buf, kind: 'folder' });
  return buf;
}

/** Re-encode a rendered tile as webp, the format collection artwork uses. */
export async function toWebp(png) {
  return sharp(png).webp({ quality: 88 }).toBuffer();
}
