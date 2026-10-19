// Remembers which logins have been used and loads them at startup.
//
// Without this, the first request after a restart pays for the whole playlist
// and guide download. A phone will usually sit through that; a TV gives up and
// leaves a row of placeholders that never fill in. So the work is done before
// anyone asks.
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = process.env.CACHE_DIR || '/app/cache';
const FILE = path.join(DIR, 'logins.json');
const MAX = 50;

async function read() {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * Record a login so the next restart can warm it. Stores the config token,
 * which already holds the credentials in the form the addon reads, encrypted
 * when CONFIG_SECRET is set.
 */
export async function remember(token) {
  if (!token) return;
  try {
    const list = await read();
    const next = [token, ...list.filter((t) => t !== token)].slice(0, MAX);
    if (next.length === list.length && next[0] === list[0]) return;
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(next), 'utf8');
  } catch (err) {
    // Warming is an optimisation; never let it break a request.
    console.warn('[warm] could not record login:', err.message);
  }
}

/**
 * Load every remembered login, one at a time so a long list cannot swamp the
 * provider or the container's memory on boot.
 */
export async function warmAll(decodeConfig, getData) {
  const list = await read();
  if (!list.length) return;
  console.log(`[warm] preloading ${list.length} saved login(s)`);
  for (const token of list) {
    try {
      const cfg = decodeConfig(token);
      const started = Date.now();
      const data = await getData(cfg);
      console.log(`[warm] ${data.channels.length} channels, ${data.groups.length} categories in ${Date.now() - started} ms`);
    } catch (err) {
      console.warn('[warm] skipped a saved login:', err.message);
    }
  }
}
