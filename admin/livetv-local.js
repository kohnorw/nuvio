// Live TV, resolved in-process.
//
// The split build called the addon over HTTP, which meant an API key and a
// container-to-container URL that could silently be wrong. Here the addon is
// the same process, so we call its own functions: nothing to misconfigure, and
// no network hop to fail.
import crypto from 'node:crypto';
import { defaults } from '../src/config.js';
import { checkLogin } from '../src/xtream.js';
import { encodeConfig } from '../src/config.js';
import { buildCollection } from '../src/manifest.js';
import { getData } from '../src/store.js';

export const liveTvApiConfigured = () => Boolean(defaults.xtreamServer);

const TTL_MS = 5 * 60 * 1000;
const memo = new Map();

function fail(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** The address customers' players use. Needed for logo and tile URLs. */
function publicBase() {
  return (defaults.publicUrl || '').replace(/\/+$/, '');
}

function tokenFor(username, password, output) {
  return encodeConfig({ xtream: { username, password, output } });
}

/** Returns { url, account, verified, cfg }. Throws a readable message. */
export async function createLiveTvLink({ username, password } = {}) {
  username = String(username ?? '').trim();
  password = String(password ?? '').trim();
  if (!username || !password) throw fail('Enter your IPTV username and password.', 400);
  if (!liveTvApiConfigured()) throw fail('Live TV is not set up — set XTREAM_URL.', 500);
  if (!publicBase()) throw fail('PUBLIC_URL is not set, so the Live TV link would not work outside this server.', 500);

  const key = crypto.createHash('sha256').update(`${username}\0${password}`).digest('hex');
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const output = defaults.xtream?.output || 'ts';
  let account;
  try {
    account = await checkLogin(
      { url: defaults.xtreamServer, username, password, output },
      defaults.userAgent
    );
  } catch (err) {
    const status = { auth: 400, expired: 403, unreachable: 502 }[err.code] || 500;
    throw fail(
      err.code === 'unreachable' ? 'Could not reach the IPTV service. Try again shortly.' : err.message,
      status
    );
  }

  const token = tokenFor(username, password, output);
  const value = {
    url: `${publicBase()}/${token}/manifest.json`,
    // Every addon route lives under the token, artwork included. Without it a
    // tile URL resolves to /tile/<id>.webp, where the server reads "tile" as
    // the config segment and rejects the request — which is exactly how a
    // blank tile happens.
    token,
    account,
    verified: true,
    // Kept so the collection can be built without re-deriving it.
    cfg: { username, password, output },
  };
  if (memo.size > 200) memo.clear();
  memo.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Build the Live TV collection for this login. Returns { collection, error };
 * a missing collection never blocks the push, but the reason is reported.
 */
export async function fetchLiveTvCollection(manifestUrl, title, creds) {
  if (!creds) return { collection: null, error: 'no IPTV login to build a collection from' };
  // Derive the token from the manifest link so artwork URLs sit under it too.
  let token = '';
  try {
    token = new URL(manifestUrl).pathname.split('/').filter(Boolean)[0] || '';
  } catch {
    token = '';
  }
  try {
    const cfg = {
      ...defaults,
      xtream: { url: defaults.xtreamServer, ...creds },
    };
    const data = await getData(cfg);
    if (!data.folders?.length) return { collection: null, error: 'no categories found on this IPTV account' };
    const root = publicBase();
    const base = token ? `${root}/${token}` : root;
    const collection = buildCollection(cfg, data, { title, base });
    // Category tiles are images served by this server. If PUBLIC_URL does not
    // resolve from the viewer's device, every tile renders blank, so say so
    // now rather than leaving someone staring at empty boxes.
    if (!root) {
      return { collection, error: null, warning: 'PUBLIC_URL is not set — category tiles will have no artwork' };
    }

    // The folders name the addon by id. If that id does not match the addon
    // actually installed, the player finds nothing to ask and the category
    // shows placeholders forever — which is exactly what a config-derived id
    // used to cause. Check it here rather than discovering it on a TV.
    const installedId = (await (async () => {
      try {
        const r = await fetch(manifestUrl, { signal: AbortSignal.timeout(20000) });
        return r.ok ? (await r.json())?.id : null;
      } catch { return null; }
    })());
    const wantedId = collection.folders[0]?.catalogSources?.[0]?.addonId;
    if (installedId && wantedId && installedId !== wantedId) {
      return {
        collection,
        error: null,
        warning: `collection points at addon "${wantedId}" but the manifest says "${installedId}" — categories would not open`,
      };
    }

    // Fetch one tile before handing the collection over. A URL that 404s here
    // would be a row of blank boxes in the app with nothing to explain it.
    const probe = collection.folders[0]?.coverImageUrl;
    if (probe) {
      try {
        const r = await fetch(probe, { method: 'GET', signal: AbortSignal.timeout(15000) });
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !type.startsWith('image/')) {
          return {
            collection,
            error: null,
            warning: `category artwork did not load (${r.status} ${type || 'no type'}) — tiles will be blank: ${probe}`,
          };
        }
      } catch (e) {
        return {
          collection,
          error: null,
          warning: `category artwork could not be fetched (${e.message}) — tiles will be blank: ${probe}`,
        };
      }
    }
    return { collection, error: null };
  } catch (err) {
    return { collection: null, error: err.message };
  }
}
