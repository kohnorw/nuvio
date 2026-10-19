// Nuvio Cloud API client (Supabase-backed).
// Endpoint surface per https://nuvio.tv/docs
const NUVIO_URL = process.env.NUVIO_URL || 'https://api.nuvio.tv';
const NUVIO_ANON_KEY =
  process.env.NUVIO_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';

async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${NUVIO_URL}${path}`, {
    method,
    headers: {
      apikey: NUVIO_ANON_KEY,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!res.ok) {
    const msg =
      parsed?.message ||
      parsed?.error_description ||
      parsed?.msg ||
      parsed?.hint ||
      `Nuvio API returned ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

export async function signIn(email, password) {
  const r = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    userId: r.user?.id,
    email: r.user?.email,
  };
}

export async function refresh(refreshToken) {
  const r = await api('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  });
  return { accessToken: r.access_token, refreshToken: r.refresh_token };
}

export async function getProfiles(token) {
  const rows = await api('/rest/v1/rpc/sync_pull_profiles', {
    token,
    method: 'POST',
    body: {},
  });
  return (rows || []).map((p) => ({
    // Addon/collection RPCs are keyed by profile_index, not the uuid.
    profileId: p.profile_index,
    name: p.name || `Profile ${p.profile_index + 1}`,
    color: p.avatar_color_hex || null,
  }));
}

export async function getAddons(token, profileId) {
  return (
    (await api(
      `/rest/v1/addons?select=*&profile_id=eq.${profileId}&order=sort_order`,
      { token }
    )) || []
  );
}

export async function getCollections(token, profileId) {
  const rows = await api('/rest/v1/rpc/sync_pull_collections', {
    token,
    method: 'POST',
    body: { p_profile_id: profileId },
  });
  const raw = rows?.[0]?.collections_json ?? null;
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

// FULL REPLACE. Caller must supply the complete desired list.
export async function pushAddons(token, profileId, addons) {
  await api('/rest/v1/rpc/sync_push_addons', {
    token,
    method: 'POST',
    body: { p_profile_id: profileId, p_addons: addons },
  });
}

// FULL REPLACE. Caller must supply the complete desired list.
export async function pushCollections(token, profileId, collections) {
  await api('/rest/v1/rpc/sync_push_collections', {
    token,
    method: 'POST',
    body: { p_profile_id: profileId, p_collections_json: collections },
  });
}

/* ------------------------------------------- library and watch progress -- */
// Same RPCs the Nuvio apps use. Unlike addons and collections these are
// per-item: push upserts by key, delete removes by key, nothing else is
// touched. Batches match the apps' own size.

const BATCH = 500;

function chunks(list, size = BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function pullLibrary(token, profileId) {
  const all = [];
  for (let offset = 0; offset < 100000; offset += BATCH) {
    const rows = await api('/rest/v1/rpc/sync_pull_library', {
      token,
      method: 'POST',
      body: { p_profile_id: profileId, p_limit: BATCH, p_offset: offset },
    });
    const page = Array.isArray(rows) ? rows : [];
    all.push(...page);
    if (page.length < BATCH) break;
  }
  return all;
}

/** Upsert, keyed by content_id + content_type. */
export async function pushLibraryItems(token, profileId, items) {
  for (const batch of chunks(items)) {
    await api('/rest/v1/rpc/sync_push_library_items', {
      token,
      method: 'POST',
      body: { p_profile_id: profileId, p_items: batch },
    });
  }
}

/** `keys` is [{ content_id, content_type }]. */
export async function deleteLibraryItems(token, profileId, keys) {
  for (const batch of chunks(keys)) {
    await api('/rest/v1/rpc/sync_delete_library_items', {
      token,
      method: 'POST',
      body: { p_profile_id: profileId, p_keys: batch },
    });
  }
}

/** Continue Watching is built from these rows. */
export async function pullWatchProgress(token, profileId) {
  const rows = await api('/rest/v1/rpc/sync_pull_watch_progress', {
    token,
    method: 'POST',
    body: { p_profile_id: profileId },
  });
  return Array.isArray(rows) ? rows : [];
}

/** Upsert, keyed by progress_key. */
export async function pushWatchProgress(token, profileId, entries) {
  for (const batch of chunks(entries)) {
    await api('/rest/v1/rpc/sync_push_watch_progress', {
      token,
      method: 'POST',
      body: { p_profile_id: profileId, p_entries: batch },
    });
  }
}

/** `keys` is a list of progress_key strings. */
export async function deleteWatchProgress(token, profileId, keys) {
  for (const batch of chunks(keys)) {
    await api('/rest/v1/rpc/sync_delete_watch_progress', {
      token,
      method: 'POST',
      body: { p_profile_id: profileId, p_keys: batch },
    });
  }
}

/**
 * Normalise a manifest URL for comparison so we don't install duplicates that
 * differ only by scheme or a trailing slash.
 */
export function normaliseUrl(u) {
  return String(u || '')
    .trim()
    .replace(/^stremio:\/\//i, 'https://')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Clean install: the profile ends up with exactly `desired`, in order.
 * Returns the list to push plus what that means for the profile.
 */
export function diffAddons(existing, desired) {
  const desiredKeys = new Set(desired.map((d) => normaliseUrl(d.url)));
  const existingKeys = new Set(existing.map((a) => normaliseUrl(a.url)));

  const removed = existing
    .filter((a) => !desiredKeys.has(normaliseUrl(a.url)))
    .map((a) => a.name || a.url);
  const added = desired
    .filter((d) => !existingKeys.has(normaliseUrl(d.url)))
    .map((d) => d.name || d.url);
  const kept = desired
    .filter((d) => existingKeys.has(normaliseUrl(d.url)))
    .map((d) => d.name || d.url);

  const addons = desired.map((d, i) => ({
    url: d.url,
    name: d.name ?? null,
    enabled: d.enabled !== false,
    sort_order: i,
  }));

  return { addons, removed, added, kept };
}
