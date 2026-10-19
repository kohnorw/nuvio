#!/usr/bin/env node
/**
 * Install this addon and its Live TV collection onto a Nuvio profile directly.
 * Useful for a single account, and for proving the collection works when a
 * push through the provisioner does not.
 *
 *   node scripts/push-collection.mjs --manifest <url> --email <you> --password <pw>
 *   node scripts/push-collection.mjs ... --profile 0        # one profile only
 *   node scripts/push-collection.mjs ... --dry-run          # show, write nothing
 *
 * Existing addons and collections are kept; a previous copy of this addon or
 * of the Live TV collection is replaced in place.
 */
const NUVIO_URL = process.env.NUVIO_URL || 'https://api.nuvio.tv';
const NUVIO_ANON_KEY =
  process.env.NUVIO_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const manifestUrl = arg('manifest');
const email = arg('email');
const password = arg('password');
const profileArg = arg('profile');
const dryRun = arg('dry-run', false) === true;
const addonName = arg('name', 'Live TV');

if (!manifestUrl || !email || !password) {
  console.error('usage: push-collection.mjs --manifest <url> --email <e> --password <p> [--profile N] [--dry-run]');
  process.exit(2);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${NUVIO_URL}${path}`, {
    method,
    headers: {
      apikey: NUVIO_ANON_KEY,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const main = async () => {
  // 1. The addon builds the collection; fetch it before touching the account.
  const collectionUrl = manifestUrl.replace(/\/manifest\.json$/, '/collection.json');
  console.log(`fetching ${collectionUrl}`);
  const res = await fetch(collectionUrl);
  if (!res.ok) throw new Error(`addon returned ${res.status} — is it the current build?`);
  const { collection } = await res.json();
  if (!collection?.folders?.length) throw new Error('addon returned no categories');
  console.log(`  "${collection.title}" with ${collection.folders.length} categories`);

  // 2. Sign in to Nuvio.
  const auth = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  const token = auth.access_token;

  const profiles = (await api('/rest/v1/rpc/sync_pull_profiles', { token, method: 'POST', body: {} })) || [];
  console.log('profiles:', profiles.map((p) => `${p.profile_index}=${p.name}`).join(', ') || '(none)');
  const targets = profileArg === null ? profiles.map((p) => p.profile_index) : [Number(profileArg)];

  for (const profileId of targets) {
    const addons =
      (await api(`/rest/v1/addons?select=*&profile_id=eq.${profileId}&order=sort_order`, { token })) || [];

    const collRows = await api('/rest/v1/rpc/sync_pull_collections', {
      token, method: 'POST', body: { p_profile_id: profileId },
    });
    // The RPC returns the whole set as one JSON column, sometimes as a string.
    let existing = collRows?.[0]?.collections_json ?? [];
    if (typeof existing === 'string') { try { existing = JSON.parse(existing); } catch { existing = []; } }
    if (!Array.isArray(existing)) existing = [];

    const keptAddons = addons.filter((a) => a.url !== manifestUrl);
    const nextAddons = [...keptAddons, { name: addonName, url: manifestUrl, enabled: true }].map((a, i) => ({
      name: a.name, url: a.url, enabled: a.enabled !== false, sort_order: i,
    }));
    const keptCollections = existing.filter((c) => c?.id !== collection.id && c?.title !== collection.title);
    const nextCollections = [...keptCollections, collection];

    console.log(
      `profile ${profileId}: ${nextAddons.length} addons, ` +
      `${nextCollections.length} collections (${keptCollections.length} kept + Live TV)`
    );
    if (dryRun) { console.log('  dry run — nothing written'); continue; }

    await api('/rest/v1/rpc/sync_push_addons', {
      token, method: 'POST', body: { p_profile_id: profileId, p_addons: nextAddons },
    });
    await api('/rest/v1/rpc/sync_push_collections', {
      token, method: 'POST', body: { p_profile_id: profileId, p_collections_json: nextCollections },
    });
    console.log('  pushed');
  }
  console.log('done — fully close and reopen Nuvio to see the row');
};

main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
