import fs from 'node:fs/promises';
import path from 'node:path';
import { engagementSummary } from './engagement.js';
import { computeStamp, scanLibrary } from './library.js';
import { cleanPlace, createGeocoder } from './places.js';

const PAGE = 3;

function missingDir(err) {
  return Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
}

function thumbUrl(item) {
  return `/media/thumb/${item.id}?v=${Math.round(item.mtimeMs)}`;
}

function fileUrl(item) {
  return `/media/file/${item.id}?v=${Math.round(item.mtimeMs)}`;
}

function coverItem(lib, album) {
  const items = [];
  for (const id of album.itemIds) {
    const item = lib.itemsById.get(id);
    if (item) items.push(item);
  }
  if (items.length === 0) return null;
  const engaged = items.some((item) => (item.likes || 0) > 0 || (item.commentCount || 0) > 0);
  if (!engaged) {
    let oldest = items[0];
    for (const item of items) {
      if (item.sortAt < oldest.sortAt || (item.sortAt === oldest.sortAt && item.rel.localeCompare(oldest.rel, 'zh') < 0)) {
        oldest = item;
      }
    }
    return oldest;
  }
  let best = null;
  let bestLikes = -1;
  let bestComments = -1;
  for (const item of items) {
    const likes = item.likes || 0;
    const comments = item.commentCount || 0;
    const newer = best && item.sortAt > best.sortAt;
    if (
      !best
      || likes > bestLikes
      || (likes === bestLikes && comments > bestComments)
      || (likes === bestLikes && comments === bestComments && newer)
    ) {
      best = item;
      bestLikes = likes;
      bestComments = comments;
    }
  }
  return best;
}

function toSummary(lib, album) {
  const cover = coverItem(lib, album);
  return {
    id: album.id,
    title: album.title,
    kind: album.kind,
    photoCount: album.photoCount,
    videoCount: album.videoCount,
    cover: cover
      ? { id: cover.id, kind: cover.kind, thumbUrl: thumbUrl(cover) }
      : null,
  };
}

export function pageAlbumSummaries(lib, offset, limit) {
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const asked = Number.isFinite(limit) ? Math.floor(limit) : PAGE;
  const size = Math.min(PAGE, Math.max(1, asked));
  return {
    total: lib.albums.length,
    offset: start,
    limit: size,
    albums: lib.albums.slice(start, start + size).map((album) => toSummary(lib, album)),
  };
}

function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').includes('..')) return '';
  return rel;
}

function hydrate(rootReal, data) {
  const itemsById = new Map();
  for (const raw of data.items || []) {
    const rel = safeRel(raw.rel);
    if (!rel || typeof raw.id !== 'string') continue;
    itemsById.set(raw.id, {
      id: raw.id,
      rel,
      name: raw.name,
      ext: raw.ext,
      kind: raw.kind,
      sortAt: raw.sortAt,
      takenAt: raw.takenAt,
      latitude: coord(raw.latitude, 90),
      longitude: coord(raw.longitude, 180),
      mtimeMs: raw.mtimeMs,
      size: raw.size,
      likes: raw.likes || 0,
      commentCount: raw.commentCount || 0,
      abs: path.join(rootReal, ...rel.split('/')),
    });
  }
  const albums = (data.albums || []).map((album) => ({
    id: album.id,
    title: album.title,
    kind: album.kind,
    photoCount: album.photoCount,
    videoCount: album.videoCount,
    stories: album.stories || [],
    itemIds: Array.isArray(album.itemIds) ? album.itemIds : [],
  }));
  return { mode: 'albums', albums, itemsById };
}

function coord(value, limit) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
}

function serialize(lib, stamp) {
  return {
    schema: 2,
    stamp,
    albums: lib.albums.map((album) => ({
      id: album.id,
      title: album.title,
      kind: album.kind,
      photoCount: album.photoCount,
      videoCount: album.videoCount,
      stories: album.stories || [],
      itemIds: album.itemIds,
    })),
    items: [...lib.itemsById.values()].map((item) => ({
      id: item.id,
      rel: item.rel,
      name: item.name,
      ext: item.ext,
      kind: item.kind,
      sortAt: item.sortAt,
      takenAt: item.takenAt,
      latitude: coord(item.latitude, 90),
      longitude: coord(item.longitude, 180),
      mtimeMs: item.mtimeMs,
      size: item.size,
      likes: item.likes || 0,
      commentCount: item.commentCount || 0,
    })),
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function buildIndex(mediaDir) {
  const scanned = await scanLibrary(mediaDir);
  const privateItems = [...scanned.itemsById.values()];
  await mapPool(privateItems, 8, async (item) => {
    const saved = await engagementSummary(item);
    item.likes = saved.likes;
    item.commentCount = saved.comments.length;
  });
  const albums = scanned.albums.map((album) => ({
    id: album.id,
    title: album.title,
    kind: album.kind,
    photoCount: album.photoCount,
    videoCount: album.videoCount,
    stories: album.stories || [],
    itemIds: album.items.map((item) => item.id),
  }));
  const itemsById = new Map(privateItems.map((item) => [item.id, item]));
  return { mode: 'albums', albums, itemsById };
}

async function publicAlbum(lib, id, geocoder) {
  const album = lib.albums.find((entry) => entry.id === id);
  if (!album) return null;
  const raw = [];
  for (const itemId of album.itemIds) {
    const item = lib.itemsById.get(itemId);
    if (item) raw.push(item);
  }
  const [savedList, places] = await Promise.all([
    mapPool(raw, 8, (item) => engagementSummary(item)),
    Promise.all(raw.map(async (item) => {
      if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude) || !geocoder) return null;
      return cleanPlace(await geocoder.peek(item.latitude, item.longitude));
    })),
  ]);
  const items = raw.map((item, index) => {
    const saved = savedList[index];
    return {
      id: item.id,
      kind: item.kind,
      takenAt: item.takenAt,
      located: Number.isFinite(item.latitude) && Number.isFinite(item.longitude),
      place: places[index],
      likes: saved.likes,
      comments: saved.comments,
      thumbUrl: thumbUrl(item),
      viewUrl: `/media/view/${item.id}?v=${Math.round(item.mtimeMs)}`,
      fileUrl: fileUrl(item),
    };
  });
  return {
    id: album.id,
    title: album.title,
    kind: album.kind,
    photoCount: album.photoCount,
    videoCount: album.videoCount,
    stories: album.stories || [],
    items,
  };
}

export function createCatalog(mediaDir, { ttl = 3000, cacheDir, geocode } = {}) {
  let memory = null;
  let pending = null;
  const stats = { scans: 0 };
  const indexPath = cacheDir ? path.join(cacheDir, 'library-index.json') : '';
  const geocoder = typeof geocode === 'function'
    ? { lookup: geocode, peek: async () => null }
    : geocode || createGeocoder({ cacheDir });

  async function readDisk() {
    if (!indexPath) return null;
    try {
      const data = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      if (!data || data.schema !== 2 || typeof data.stamp !== 'string' || !Array.isArray(data.albums) || !Array.isArray(data.items)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async function writeDisk(lib, stamp) {
    if (!indexPath) return;
    const body = JSON.stringify(serialize(lib, stamp));
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const tmp = `${indexPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, indexPath);
  }

  async function refresh() {
    const now = Date.now();
    let rootReal;
    try {
      rootReal = await fs.realpath(mediaDir);
    } catch (err) {
      if (missingDir(err)) {
        const missing = new Error('还没有找到照片文件夹');
        missing.code = 'ENOENT';
        throw missing;
      }
      throw err;
    }
    if (!memory) {
      const disk = await readDisk();
      if (disk) memory = { stamp: disk.stamp, lib: hydrate(rootReal, disk), checked: 0 };
    }
    let stamp;
    try {
      stamp = await computeStamp(mediaDir);
    } catch (err) {
      if (missingDir(err)) {
        const missing = new Error('还没有找到照片文件夹');
        missing.code = 'ENOENT';
        throw missing;
      }
      throw err;
    }
    if (memory && memory.stamp === stamp) {
      memory.checked = now;
      return memory.lib;
    }
    stats.scans += 1;
    const lib = await buildIndex(mediaDir);
    memory = { stamp, lib, checked: now };
    await writeDisk(lib, stamp);
    return lib;
  }

  async function get() {
    const now = Date.now();
    if (memory && now - memory.checked < ttl) return memory.lib;
    if (!memory) {
      const disk = await readDisk();
      if (disk) {
        try {
          const rootReal = await fs.realpath(mediaDir);
          memory = { stamp: disk.stamp, lib: hydrate(rootReal, disk), checked: 0 };
        } catch (err) {
          if (!missingDir(err)) throw err;
        }
      }
    }
    if (!pending) {
      pending = refresh().then((lib) => lib, (err) => {
        console.error(err);
        if (memory) return memory.lib;
        throw err;
      }).finally(() => {
        pending = null;
      });
    }
    if (memory) return memory.lib;
    return pending;
  }

  return {
    stats,
    get,
    async page(offset, limit) {
      return pageAlbumSummaries(await get(), offset, limit);
    },
    async album(id) {
      return publicAlbum(await get(), id, geocoder);
    },
    async place(id) {
      const lib = await get();
      const item = lib.itemsById.get(id);
      if (!item) return null;
      if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return { place: null };
      return { place: cleanPlace(await geocoder.lookup(item.latitude, item.longitude)) };
    },
    async remember(itemId, saved) {
      const lib = await get();
      const item = lib.itemsById.get(itemId);
      if (!item || !memory) return;
      item.likes = saved.likes || 0;
      item.commentCount = saved.comments?.length || 0;
      await writeDisk(lib, memory.stamp);
    },
  };
}
