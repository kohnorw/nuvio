import crypto from 'node:crypto';
import { stripEmoji } from './logos.js';

export const VERSION = '2.0.0';

export function groupCatalogId(group) {
  return 'iptv_g_' + crypto.createHash('sha1').update(group).digest('hex').slice(0, 8);
}

export function buildManifest(cfg, data) {
  // Callers pass partial data (startup log, debug route) and, in per-customer
  // mode, no data at all. Fill the gaps rather than throwing.
  data = { groups: [], channels: [], folders: [], ...(data || {}) };
  const groups = data?.groups || [];
  // The id must NOT depend on the configuration. A collection's folders name
  // the addon by id, so deriving it from the config meant that changing any
  // setting — EXCLUDE_GROUPS, the login, the playlist — renamed the addon and
  // orphaned every collection already pushed: the player fetches the manifest,
  // finds no addon matching the folders, and never asks for a catalog, leaving
  // a row of placeholders that never fill in.
  const idSuffix = cfg.addonId;

  const catalogs = [];

  // Collection-only mode: the Live TV collection is the whole interface, so
  // the addon contributes no rows of its own. The channels catalog still has
  // to exist for the collection's folders to point at, but marking its genre
  // extra as required keeps it off the home screen — a catalog that cannot be
  // opened without a genre is not a browsable row. The collection always
  // supplies a genre, so its folders work normally.
  if (cfg.collectionOnly) {
    catalogs.push({
      type: 'tv',
      id: 'iptv_channels',
      name: cfg.catalogName,
      extra: [
        { name: 'genre', options: groups, isRequired: true },
        { name: 'skip', isRequired: false },
      ],
      extraSupported: ['genre', 'skip'],
    });
    // Search. Required `search` keeps it off the home screen for the same
    // reason required `genre` does — it cannot be opened by browsing — while
    // still letting the player query it when someone types a channel name.
    if (cfg.searchable) {
      catalogs.push({
        type: 'tv',
        id: 'iptv_search',
        name: cfg.searchCatalogName,
        extra: [
          { name: 'search', isRequired: true },
          { name: 'skip', isRequired: false },
        ],
        extraSupported: ['search', 'skip'],
      });
    }
    return manifestShell(cfg, data, idSuffix, catalogs);
  }

  // Categories lead the home screen.
  if (cfg.folders) {
    catalogs.push({
      type: 'tv',
      id: 'iptv_folders',
      name: cfg.folderCatalogName,
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
      extraSupported: ['search', 'skip'],
    });
  }

  // The flat every-channel row. Shown when asked for, or as a fallback when
  // nothing else would produce a row at all (no folders, no category rows, or
  // a playlist whose categories are not known yet).
  const haveCategoryRows = (cfg.splitGroups || cfg.categoryCatalogs) && groups.length > 0;
  if (cfg.showAllChannels || (!cfg.folders && !haveCategoryRows)) {
    catalogs.push({
      type: 'tv',
      id: 'iptv_channels',
      name: cfg.catalogName,
      extra: [
        { name: 'genre', options: groups, isRequired: false },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
      extraSupported: ['genre', 'search', 'skip'],
    });
  }

  // One catalog per category. A Nuvio collection folder points at a catalog,
  // so this is what lets "Live TV" have a folder per category that opens into
  // that category's channels.
  if (cfg.splitGroups || cfg.categoryCatalogs) {
    for (const g of groups.slice(0, cfg.maxSplitGroups)) {
      catalogs.push({
        type: 'tv',
        id: groupCatalogId(g),
        name: g,
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false },
        ],
        extraSupported: ['search', 'skip'],
      });
    }
  }

  return manifestShell(cfg, data, idSuffix, catalogs);
}

function manifestShell(cfg, data, idSuffix, catalogs) {
  return {
    id: `community.iptv.live.${idSuffix}`,
    version: VERSION,
    name: cfg.name,
    description:
      `Live TV from your own playlist — ${data?.channels?.length ?? 0} channels, ` +
      `station logos, and XMLTV guide data showing what is on now and next.`,
    logo: 'https://raw.githubusercontent.com/Stremio/stremio-art/main/orig/stremio_symbol.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: ['iptv:'],
    catalogs,
    // No configure page to point at, so no Configure button.
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}


/**
 * A Nuvio collection describing this addon's categories: one folder per
 * category, each bound to that category's catalog, with square tiles so the
 * grid matches the channel logos.
 *
 * Ids are derived from the addon id and the category name rather than random,
 * so re-pushing updates the same folders instead of duplicating them.
 */
function uuidFrom(...parts) {
  const h = crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 32);
  // Shape the digest as a v5-looking UUID; Nuvio only needs a stable unique id.
  return [h.slice(0, 8), h.slice(8, 12), '5' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32)].join('-');
}

export function buildCollection(cfg, data, { title = 'Live TV', base = '' } = {}) {
  const manifest = buildManifest(cfg, data);
  const addonId = manifest.id;
  // One catalog for everything; each folder is the same catalog filtered to
  // its category. That is why the addon publishes a single channels catalog
  // rather than one per category.
  const folders = (data?.folders || []).map((f) => {
    const source = {
      addonId,
      type: 'tv',
      catalogId: 'iptv_channels',
      genre: f.name,
    };
    return {
      id: uuidFrom(addonId, 'folder', f.name),
      // Display only. The genre below keeps the provider's exact name, so
      // tidying the label here cannot break category matching.
      title: stripEmoji(f.name) || f.name,
      // The tile is a rendered label, so the title would be printed twice.
      // Always let the player draw the name. The cover art carries it too, but
      // if an image fails to load the tile would otherwise be blank.
      hideTitle: false,
      // Deliberately plain: no query string and nothing needing percent
      // encoding, matching the artwork URLs other collections use.
      // TILE_TEST_URL overrides it, to tell a bad image apart from a bad
      // folder object.
      coverImageUrl: cfg.tileTestUrl || (base ? `${base}/tile/${f.tileId}.webp` : null),
      coverEmoji: null,
      focusGifUrl: null,
      focusGifEnabled: false,
      // Every folder that renders in other collections has one of these, so
      // supply it rather than leaving it null.
      heroBackdropUrl: cfg.tileTestUrl || (base ? `${base}/tile/${f.tileId}.webp` : null),
      heroVideoUrl: null,
      titleLogoUrl: null,
      // The folder tile is a wide banner, like a streaming-service row.
      tileShape: 'LANDSCAPE',
      catalogSources: [source],
      sources: [{ provider: 'addon', ...source }],
    };
  });

  return {
    id: uuidFrom(addonId, 'collection', title),
    title,
    pinToTop: true,
    focusGlowEnabled: true,
    viewMode: 'FOLLOW_LAYOUT',
    showAllTab: true,
    backdropImageUrl: null,
    folders,
  };
}
