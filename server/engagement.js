import fs from 'node:fs/promises';
import path from 'node:path';

function empty() {
  return { likes: 0, comments: [] };
}

function normalize(data) {
  const likes = Number(data?.likes);
  const comments = [];
  if (Array.isArray(data?.comments)) {
    for (const entry of data.comments) {
      if (!entry || typeof entry !== 'object') continue;
      const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, 200) : '';
      if (!text) continue;
      comments.push({
        id: typeof entry.id === 'string' ? entry.id.slice(0, 40) : '',
        text,
        at: typeof entry.at === 'string' ? entry.at.slice(0, 40) : '',
      });
      if (comments.length >= 100) break;
    }
  }
  return {
    likes: Number.isInteger(likes) && likes > 0 ? Math.min(likes, 100000) : 0,
    comments,
  };
}

export function commentFileFor(item) {
  const base = path.basename(item.name, path.extname(item.name));
  return path.join(path.dirname(item.abs), 'comments', `${base}.json`);
}

export async function engagementSummary(item) {
  return readFileEngagement(item);
}

async function readFileEngagement(item) {
  try {
    return normalize(JSON.parse(await fs.readFile(commentFileFor(item), 'utf8')));
  } catch (err) {
    if (err && err.code === 'ENOENT') return empty();
    throw err;
  }
}

const chains = new Map();

function updateFile(item, fn) {
  const file = commentFileFor(item);
  const prev = chains.get(file) || Promise.resolve();
  const run = prev.then(async () => {
    const current = await readFileEngagement(item);
    const next = normalize(fn(current) || current);
    if (next.likes === 0 && next.comments.length === 0) {
      await fs.rm(file, { force: true });
      return next;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2));
    await fs.rename(tmp, file);
    return next;
  });
  chains.set(file, run.then(() => {}, () => {}));
  return run;
}

export function changeLike(item, on) {
  return updateFile(item, (data) => {
    data.likes = Math.max(0, data.likes + (on ? 1 : -1));
    return data;
  });
}

export function addComment(item, entry) {
  return updateFile(item, (data) => {
    data.comments = data.comments.concat(entry).slice(-100);
    return data;
  });
}

function whenOf(item) {
  if (Number.isFinite(item?.sortAt)) return item.sortAt;
  const parsed = Date.parse(item?.takenAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function pickCover(items) {
  if (!items?.length) return null;
  const engaged = items.some((item) => (item.likes || 0) > 0 || (item.comments?.length || 0) > 0 || (item.commentCount || 0) > 0);
  if (!engaged) {
    let oldest = items[0];
    for (const item of items) {
      if (whenOf(item) < whenOf(oldest)) oldest = item;
    }
    return oldest.id;
  }
  let best = items[0];
  let bestLikes = -1;
  let bestComments = -1;
  for (const item of items) {
    const likes = item.likes || 0;
    const comments = item.comments?.length || item.commentCount || 0;
    const newer = whenOf(item) > whenOf(best);
    if (
      likes > bestLikes
      || (likes === bestLikes && comments > bestComments)
      || (likes === bestLikes && comments === bestComments && newer)
    ) {
      best = item;
      bestLikes = likes;
      bestComments = comments;
    }
  }
  return best.id;
}

export async function applyEngagement(albums, itemsById) {
  const saved = new Map();
  await Promise.all([...itemsById.values()].map(async (item) => {
    saved.set(item.id, await readFileEngagement(item));
  }));
  return albums.map((album) => {
    const items = album.items.map((item) => {
      const extra = saved.get(item.id) || empty();
      return { ...item, likes: extra.likes, comments: extra.comments };
    });
    return { ...album, items, coverItemId: pickCover(items) };
  });
}
