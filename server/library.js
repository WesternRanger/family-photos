import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp',
]);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);

/**
 * Reserved for a later version. This release does not render a journal.
 * stories.json in an album folder is read into this shape and kept on the album:
 *   { date: "YYYY-MM-DD", text: "短短几句", mediaIds: ["<item id>", ...] }
 * `media` in the file may be a file name or a path relative to that album.
 */
export const STORY_SHAPE = Object.freeze({
  date: 'YYYY-MM-DD',
  text: 'string',
  mediaIds: ['item id'],
});

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

export function mimeFor(ext) {
  return MIME[ext] || 'application/octet-stream';
}

const LIVE_VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v']);
const LIVE_HARD_MAX = 80 * 1024 * 1024;
const LIVE_SOFT_MAX = 40 * 1024 * 1024;
const LIVE_STILL_TIME = 'com.apple.quicktime.still-image-time';
const LIVE_CONTENT_KEY = 'com.apple.quicktime.content.identifier';
const UUID_RE = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;
const STILL_RANK = new Map([
  ['.heic', 0], ['.heif', 1], ['.jpg', 2], ['.jpeg', 3], ['.png', 4],
  ['.webp', 5], ['.tif', 6], ['.tiff', 7], ['.bmp', 8], ['.gif', 9],
]);

function stemKey(rel) {
  const ext = path.posix.extname(rel);
  const base = path.posix.basename(rel, ext).toLowerCase();
  const dir = path.posix.dirname(rel);
  const folder = dir === '.' ? '' : dir.toLowerCase();
  return `${folder}/${base}`;
}

function stillRank(item) {
  return STILL_RANK.get(item.ext) ?? 20;
}

function videoRank(item) {
  if (item.ext === '.mov') return 0;
  if (item.ext === '.mp4') return 1;
  if (item.ext === '.m4v') return 2;
  return 3;
}

async function readSlice(abs, size, head, tail = 0) {
  const handle = await fs.open(abs, 'r');
  try {
    const headLen = Math.min(Math.max(size, 0), head);
    const headBuf = Buffer.alloc(headLen);
    if (headLen) await handle.read(headBuf, 0, headLen, 0);
    if (!tail || size <= headLen) return headBuf;
    const tailLen = Math.min(tail, size - headLen);
    const tailBuf = Buffer.alloc(tailLen);
    await handle.read(tailBuf, 0, tailLen, size - tailLen);
    return Buffer.concat([headBuf, tailBuf]);
  } finally {
    await handle.close();
  }
}

async function readAt(abs, start, length) {
  const handle = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function contentIdNear(text, key) {
  const at = text.indexOf(key);
  if (at < 0) return '';
  const slice = text.slice(Math.max(0, at - 80), at + 4096);
  const found = UUID_RE.exec(slice);
  return found ? found[0].toUpperCase() : '';
}

export function readLiveMarkers(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : '';
  const stillImageTime = text.includes(LIVE_STILL_TIME);
  let contentId = contentIdNear(text, LIVE_CONTENT_KEY);
  if (!contentId) {
    const xmp = /ContentIdentifier[^0-9A-Fa-f]{0,12}([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/.exec(text);
    if (xmp) contentId = xmp[1].toUpperCase();
  }
  return { stillImageTime, contentId };
}

export function embeddedMotionCandidates(buffer, fileSize = buffer?.length || 0) {
  if (!buffer || fileSize < 64) return [];
  const text = buffer.subarray(0, Math.min(buffer.length, 131072)).toString('latin1');
  if (!/(?:MicroVideo|MotionPhoto)(?:=["']|>)\s*1\b/.test(text)) return [];
  const lengths = [];
  const off = /MicroVideoOffset(?:=["']|>)\s*(\d+)/.exec(text);
  if (off) lengths.push(Number(off[1]));
  const re = /Item:Length(?:=["']|>)\s*(\d+)/g;
  let match;
  while ((match = re.exec(text))) lengths.push(Number(match[1]));
  const candidates = [];
  const seen = new Set();
  for (const length of lengths) {
    if (!Number.isInteger(length) || length < 32 || length >= fileSize || seen.has(length)) continue;
    seen.add(length);
    const offset = fileSize - length;
    if (offset < 0) continue;
    if (offset + 8 <= buffer.length && buffer.toString('ascii', offset + 4, offset + 8) !== 'ftyp') continue;
    candidates.push({ offset, length });
  }
  return candidates;
}

export function findEmbeddedMotion(buffer, fileSize = buffer?.length || 0) {
  const candidates = embeddedMotionCandidates(buffer, fileSize);
  return candidates.find((candidate) => (
    candidate.offset + 8 <= buffer.length
    && buffer.toString('ascii', candidate.offset + 4, candidate.offset + 8) === 'ftyp'
  )) || null;
}

function pairMatches(still, video, size) {
  if (!still || !video) return false;
  if (still.contentId && video.contentId && still.contentId !== video.contentId) return false;
  if (video.stillImageTime || video.contentId) return true;
  if (still.contentId && size <= LIVE_SOFT_MAX) return true;
  return false;
}

function chooseStill(photos, signals, videoSignals) {
  if (videoSignals.contentId) {
    const match = photos.find((photo) => signals.get(photo.id)?.contentId === videoSignals.contentId);
    if (match) return match;
  }
  const ranked = photos.slice().sort((a, b) => stillRank(a) - stillRank(b) || a.rel.localeCompare(b.rel, 'zh'));
  if (!videoSignals.contentId) {
    const tagged = ranked.find((photo) => signals.get(photo.id)?.contentId);
    if (tagged) return tagged;
  }
  return ranked[0] || null;
}

async function pairGroup(photos, videos) {
  const ranked = [];
  for (const video of videos) {
    ranked.push({ video, signals: readLiveMarkers(await readSlice(video.abs, video.size, 2 * 1024 * 1024, 2 * 1024 * 1024)) });
  }
  ranked.sort((a, b) => {
    const score = (signals) => (signals.stillImageTime ? 2 : 0) + (signals.contentId ? 1 : 0);
    return score(b.signals) - score(a.signals) || videoRank(a.video) - videoRank(b.video);
  });
  const signals = new Map();
  for (const photo of photos) {
    signals.set(photo.id, readLiveMarkers(await readSlice(photo.abs, photo.size, 262144, 0)));
  }
  for (const candidate of ranked) {
    const still = chooseStill(photos, signals, candidate.signals);
    if (!still) continue;
    if (!pairMatches(signals.get(still.id), candidate.signals, candidate.video.size)) continue;
    still.liveVideoId = candidate.video.id;
    candidate.video.liveMotion = true;
    return;
  }
}

async function readEmbeddedFile(photo) {
  const head = await readSlice(photo.abs, photo.size, 131072, 0);
  const candidates = embeddedMotionCandidates(head, photo.size);
  for (const candidate of candidates) {
    let probe = null;
    if (candidate.offset + 8 <= head.length) probe = head.subarray(candidate.offset, candidate.offset + 12);
    else probe = await readAt(photo.abs, candidate.offset, 12);
    if (probe.length >= 8 && probe.toString('ascii', 4, 8) === 'ftyp') return candidate;
  }
  return null;
}

// Same-name still + short video from an iPhone Live Photo export.
// The motion file is kept for playback and left out of the album.
async function attachLivePhotos(items) {
  const groups = new Map();
  for (const item of items) {
    const key = stemKey(item.rel);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  const pairs = [];
  for (const group of groups.values()) {
    const photos = group.filter((item) => item.kind === 'photo');
    const videos = group.filter((item) => item.kind === 'video' && LIVE_VIDEO_EXT.has(item.ext) && item.size > 0 && item.size <= LIVE_HARD_MAX);
    if (photos.length && videos.length) pairs.push({ photos, videos });
  }
  await mapPool(pairs, 4, async ({ photos, videos }) => {
    try {
      await pairGroup(photos, videos);
    } catch {
      /* leave the files as an ordinary still and video */
    }
  });
  const jpegs = items.filter((item) => (
    item.kind === 'photo'
    && !item.liveVideoId
    && (item.ext === '.jpg' || item.ext === '.jpeg')
  ));
  await mapPool(jpegs, 8, async (photo) => {
    try {
      const embedded = await readEmbeddedFile(photo);
      if (embedded) photo.liveEmbedded = embedded;
    } catch {
      /* ordinary still */
    }
  });
}

export function publicLiveUrl(item) {
  if (!item || (!item.liveVideoId && !item.liveEmbedded)) return '';
  return `/media/live/${item.id}?v=${Math.round(item.mtimeMs)}`;
}

export function liveTarget(item, itemsById) {
  if (!item) return null;
  if (item.liveVideoId) {
    const video = itemsById?.get(item.liveVideoId);
    if (!video?.abs || video.liveMotion !== true || video.kind !== 'video') return null;
    return { abs: video.abs, ext: video.ext };
  }
  const span = item.liveEmbedded;
  if (!span || !item.abs) return null;
  const { offset, length } = span;
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 32) return null;
  return { abs: item.abs, ext: '.mp4', span: { start: offset, end: offset + length - 1 } };
}

export function stableId(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function skipEntry(name) {
  return name.startsWith('.') || name.startsWith('._') || name === '__MACOSX' || name === 'comments';
}

function isMediaName(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext);
}

function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

function buildExifApp1(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!match) return null;
  const dateBuf = Buffer.from(`${match[1]}:${match[2]}:${match[3]} 12:00:00\0`, 'ascii');
  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const exifIfd = 26;
  const stringAt = 44;
  const tiff = Buffer.concat([
    Buffer.from('II'),
    u16(42),
    u32(8),
    u16(1),
    u16(0x8769),
    u16(4),
    u32(1),
    u32(exifIfd),
    u32(0),
    u16(1),
    u16(0x9003),
    u16(2),
    u32(dateBuf.length),
    u32(stringAt),
    u32(0),
    dateBuf,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xe1;
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([marker, payload]);
}

export function embedJpegDate(buffer, isoDate) {
  if (!buffer || buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;
  if (readJpegTakenAt(buffer)) return buffer;
  const app1 = buildExifApp1(isoDate);
  if (!app1) return buffer;
  return Buffer.concat([buffer.subarray(0, 2), app1, buffer.subarray(2)]);
}

function decimalToDms(value) {
  const abs = Math.abs(Number(value));
  const deg = Math.floor(abs + 1e-8);
  const minutesFull = (abs - deg) * 60;
  const min = Math.floor(minutesFull + 1e-8);
  const sec = (minutesFull - min) * 60;
  return { deg, min, secNum: Math.round(sec * 1000), secDen: 1000 };
}

function rationalBytes(deg, min, secNum, secDen) {
  const buf = Buffer.alloc(24);
  const write = (at, num, den) => {
    buf.writeUInt32LE(num, at);
    buf.writeUInt32LE(den, at + 4);
  };
  write(0, deg, 1);
  write(8, min, 1);
  write(16, secNum, secDen);
  return buf;
}

export function embedJpegGps(buffer, isoDate, latitude, longitude) {
  if (!buffer || buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return buffer;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!match) return buffer;
  const dateBuf = Buffer.from(`${match[1]}:${match[2]}:${match[3]} 12:00:00\0`, 'ascii');
  const latDms = decimalToDms(lat);
  const lonDms = decimalToDms(lon);
  const latRef = Buffer.from(lat < 0 ? 'S\0\0\0' : 'N\0\0\0', 'ascii');
  const lonRef = Buffer.from(lon < 0 ? 'W\0\0\0' : 'E\0\0\0', 'ascii');
  const latRats = rationalBytes(latDms.deg, latDms.min, latDms.secNum, latDms.secDen);
  const lonRats = rationalBytes(lonDms.deg, lonDms.min, lonDms.secNum, lonDms.secDen);
  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const exifIfd = 38;
  const dateAt = 56;
  const gpsIfd = 76;
  const latAt = 130;
  const lonAt = 154;
  const tiff = Buffer.concat([
    Buffer.from('II'),
    u16(42),
    u32(8),
    u16(2),
    u16(0x8769), u16(4), u32(1), u32(exifIfd),
    u16(0x8825), u16(4), u32(1), u32(gpsIfd),
    u32(0),
    u16(1),
    u16(0x9003), u16(2), u32(dateBuf.length), u32(dateAt),
    u32(0),
    dateBuf,
    u16(4),
    u16(1), u16(2), u32(2), latRef,
    u16(2), u16(5), u32(3), u32(latAt),
    u16(3), u16(2), u32(2), lonRef,
    u16(4), u16(5), u32(3), u32(lonAt),
    u32(0),
    latRats,
    lonRats,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xe1;
  marker.writeUInt16BE(payload.length + 2, 2);
  const stripped = stripExifApp1(buffer);
  return Buffer.concat([stripped.subarray(0, 2), marker, payload, stripped.subarray(2)]);
}

function stripExifApp1(buffer) {
  const parts = [buffer.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      parts.push(buffer.subarray(offset));
      return Buffer.concat(parts);
    }
    const size = buffer.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > buffer.length) break;
    const end = offset + 2 + size;
    const isExif = marker === 0xe1 && buffer.toString('ascii', offset + 4, Math.min(end, offset + 8)) === 'Exif';
    if (!isExif) parts.push(buffer.subarray(offset, end));
    offset = end;
  }
  if (offset < buffer.length) parts.push(buffer.subarray(offset));
  return Buffer.concat(parts);
}

export function readJpegTakenAt(buffer) {
  if (!buffer || buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const size = buffer.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > buffer.length) return null;
    if (marker === 0xe1) {
      const start = offset + 4;
      if (buffer.toString('ascii', start, Math.min(buffer.length, start + 4)) === 'Exif') {
        const found = readExifDate(buffer, start + 6);
        if (found) return found;
      }
    }
    offset += 2 + size;
  }
  return null;
}

function readExifDate(buffer, tiff) {
  if (tiff + 8 > buffer.length) return null;
  const endian = buffer.toString('ascii', tiff, tiff + 2);
  const le = endian === 'II';
  if (!le && endian !== 'MM') return null;
  const u16 = (o) => {
    if (o < 0 || o + 2 > buffer.length) return null;
    return le ? buffer.readUInt16LE(o) : buffer.readUInt16BE(o);
  };
  const u32 = (o) => {
    if (o < 0 || o + 4 > buffer.length) return null;
    return le ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o);
  };
  if (u16(tiff + 2) !== 42) return null;
  const ifd0rel = u32(tiff + 4);
  if (ifd0rel == null) return null;
  const ifd0 = readIfd(buffer, tiff, tiff + ifd0rel, u16, u32);
  if (!ifd0) return null;
  let original = null;
  const exifOff = ifd0.get(0x8769);
  if (typeof exifOff === 'number') {
    const exif = readIfd(buffer, tiff, tiff + exifOff, u16, u32);
    original = exif?.get(0x9003) ?? null;
  }
  const raw = typeof original === 'string' ? original : ifd0.get(0x0132);
  const date = typeof raw === 'string' ? parseExifDate(raw) : null;
  let gps = null;
  const gpsOff = ifd0.get(0x8825);
  if (typeof gpsOff === 'number') {
    gps = readGpsPlace(buffer, tiff, tiff + gpsOff, u16, u32, le);
  }
  if (!date && !gps) return null;
  return {
    takenAt: date?.takenAt,
    sortAt: date?.sortAt,
    latitude: gps?.latitude ?? null,
    longitude: gps?.longitude ?? null,
  };
}

function readIfd(buffer, tiff, ifd, u16, u32) {
  if (ifd < 0 || ifd + 2 > buffer.length) return null;
  const count = u16(ifd);
  if (count == null || count > 400) return null;
  const map = new Map();
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > buffer.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const n = u32(entry + 4);
    if (tag == null || type == null || n == null) continue;
    if ((tag === 0x8769 || tag === 0x8825) && type === 4) {
      const pointer = u32(entry + 8);
      if (pointer != null) map.set(tag, pointer);
      continue;
    }
    if ((tag === 0x9003 || tag === 0x0132) && type === 2) {
      const text = readAscii(buffer, tiff, entry, n, u32);
      if (text) map.set(tag, text);
    }
  }
  return map;
}

function readAscii(buffer, tiff, entry, n, u32) {
  if (n <= 0 || n > 80) return null;
  const start = n <= 4 ? entry + 8 : tiff + u32(entry + 8);
  if (start == null || start < 0 || start + n > buffer.length) return null;
  return buffer.toString('ascii', start, start + n).replace(/\0+$/g, '').trim();
}

function readRationals(buffer, tiff, entry, n, u32, le) {
  if (n <= 0 || n > 6) return null;
  const bytes = n * 8;
  let start = entry + 8;
  if (bytes > 4) {
    const rel = u32(entry + 8);
    if (rel == null) return null;
    start = tiff + rel;
  }
  const values = [];
  for (let i = 0; i < n; i += 1) {
    const at = start + i * 8;
    if (at < 0 || at + 8 > buffer.length) return null;
    const num = le ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
    const den = le ? buffer.readUInt32LE(at + 4) : buffer.readUInt32BE(at + 4);
    if (!den) return null;
    values.push(num / den);
  }
  return values;
}

function readGpsPlace(buffer, tiff, ifd, u16, u32, le) {
  if (ifd < 0 || ifd + 2 > buffer.length) return null;
  const count = u16(ifd);
  if (count == null || count > 40) return null;
  let latRef = '';
  let lonRef = '';
  let lat = null;
  let lon = null;
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > buffer.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const n = u32(entry + 4);
    if (tag == null || type == null || n == null) continue;
    if ((tag === 1 || tag === 3) && type === 2) {
      const text = readAscii(buffer, tiff, entry, n, u32);
      if (tag === 1) latRef = text || '';
      else lonRef = text || '';
    } else if ((tag === 2 || tag === 4) && type === 5) {
      const values = readRationals(buffer, tiff, entry, n, u32, le);
      if (tag === 2) lat = values;
      else lon = values;
    }
  }
  return gpsPoint(latRef, lat, lonRef, lon);
}

function gpsPoint(latRef, lat, lonRef, lon) {
  if (!lat || lat.length < 3 || !lon || lon.length < 3) return null;
  const latRefText = String(latRef || '').toUpperCase();
  const lonRefText = String(lonRef || '').toUpperCase();
  const latSign = latRefText.startsWith('S') ? -1 : latRefText.startsWith('N') ? 1 : 0;
  const lonSign = lonRefText.startsWith('W') ? -1 : lonRefText.startsWith('E') ? 1 : 0;
  if (!latSign || !lonSign) return null;
  const decimal = (parts) => parts[0] + parts[1] / 60 + parts[2] / 3600;
  const latitude = latSign * decimal(lat);
  const longitude = lonSign * decimal(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function parseExifDate(raw) {
  const match = /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const sortAt = new Date(year, month - 1, day, hour, minute, second).getTime();
  if (Number.isNaN(sortAt)) return null;
  return { takenAt: `${match[1]}-${match[2]}-${match[3]}`, sortAt };
}

async function readJpegFileDate(abs) {
  const handle = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return readJpegTakenAt(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function describeFiles(absList, rootReal) {
  const described = await mapPool(absList, 8, async (abs) => {
    let real;
    try {
      real = await fs.realpath(abs);
    } catch {
      return null;
    }
    const rel = path.relative(rootReal, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    let st;
    try {
      st = await fs.stat(real);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const relPosix = rel.split(path.sep).join('/');
    const ext = path.extname(relPosix).toLowerCase();
    const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'photo' : null;
    if (!kind) return null;
    let taken = null;
    if (ext === '.jpg' || ext === '.jpeg') {
      try {
        taken = await readJpegFileDate(real);
      } catch {
        taken = null;
      }
    }
    return {
      id: stableId(`item:${relPosix}`),
      abs: real,
      rel: relPosix,
      name: path.posix.basename(relPosix),
      ext,
      kind,
      sortAt: taken?.sortAt ?? st.mtimeMs,
      takenAt: taken?.takenAt ?? localDate(st.mtimeMs),
      latitude: Number.isFinite(taken?.latitude) ? taken.latitude : null,
      longitude: Number.isFinite(taken?.longitude) ? taken.longitude : null,
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
  });
  return described.filter(Boolean);
}

async function collectFiles(dir, rootReal) {
  const found = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipEntry(entry.name) || entry.isSymbolicLink()) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && isMediaName(entry.name)) found.push(abs);
    }
  }
  await walk(dir);
  return describeFiles(found, rootReal);
}

async function readStories(dir, items, albumTitle, kind) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(path.join(dir, 'stories.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const byKey = new Map();
  for (const item of items) {
    byKey.set(item.name, item.id);
    byKey.set(item.rel, item.id);
    if (kind === 'folder' && item.rel.startsWith(`${albumTitle}/`)) {
      byKey.set(item.rel.slice(albumTitle.length + 1), item.id);
    }
  }
  const stories = [];
  for (const entry of data.slice(0, 100)) {
    if (!entry || typeof entry !== 'object') continue;
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, 1000) : '';
    const date = typeof entry.date === 'string' ? entry.date.trim().slice(0, 40) : '';
    const mediaIds = [];
    const pushId = (id) => {
      if (id && !mediaIds.includes(id)) mediaIds.push(id);
    };
    if (Array.isArray(entry.mediaIds)) {
      for (const id of entry.mediaIds) {
        if (typeof id === 'string' && items.some((item) => item.id === id)) pushId(id);
      }
    }
    if (Array.isArray(entry.media)) {
      for (const name of entry.media) {
        if (typeof name === 'string') pushId(byKey.get(name.trim()));
      }
    }
    if (!text && !date && mediaIds.length === 0) continue;
    stories.push({ date, text, mediaIds });
  }
  return stories;
}

const OCCASION_RANK = new Map([
  ['出生', 0],
  ['满月', 1],
  ['100天', 2],
  ['百天', 2],
  ['百日', 2],
  ['6个月', 3],
  ['半岁', 3],
  ['周岁', 4],
  ['一岁', 4],
  ['抓周', 5],
]);

function compactName(value) {
  return String(value || '').replace(/\s+/g, '');
}

async function readOccasionMeta(dir) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, 'album.json'), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

async function collectStories(rootReal, items) {
  const stories = [];
  const ids = new Set(items.map((item) => item.id));
  async function walk(dir, relDir) {
    if (stories.length >= 100) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const found = await readStories(dir, items, relDir, relDir ? 'folder' : 'flat');
    for (const story of found) {
      if (stories.length >= 100) break;
      const mediaIds = story.mediaIds.filter((id) => ids.has(id));
      if (mediaIds.length === 0) continue;
      stories.push({ ...story, mediaIds });
    }
    for (const entry of entries) {
      if (stories.length >= 100) return;
      if (skipEntry(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const next = relDir ? `${relDir}/${entry.name}` : entry.name;
      await walk(path.join(dir, entry.name), next);
    }
  }
  await walk(rootReal, '');
  return stories;
}

function storiesFor(allStories, items) {
  const ids = new Set(items.map((item) => item.id));
  const stories = [];
  for (const story of allStories) {
    const mediaIds = story.mediaIds.filter((id) => ids.has(id));
    if (mediaIds.length === 0) continue;
    stories.push({ date: story.date, text: story.text, mediaIds });
    if (stories.length >= 100) break;
  }
  return stories;
}

function monthTitle(key) {
  const [year, month] = key.split('-');
  return `${Number(year)}年${Number(month)}月`;
}

async function makeAlbum({ id, title, kind, items, stories, rank = 0 }) {
  items.sort((a, b) => b.sortAt - a.sortAt || a.rel.localeCompare(b.rel, 'zh'));
  return {
    id,
    title,
    kind,
    rank,
    items,
    stories: (stories || []).slice(0, 100),
    photoCount: items.filter((item) => item.kind === 'photo').length,
    videoCount: items.filter((item) => item.kind === 'video').length,
    coverItemId: items[0]?.id || null,
    newest: items[0]?.sortAt || 0,
  };
}

function toPublicItem(item) {
  const version = Math.round(item.mtimeMs);
  const publicItem = {
    id: item.id,
    kind: item.kind,
    takenAt: item.takenAt,
    latitude: Number.isFinite(item.latitude) ? item.latitude : null,
    longitude: Number.isFinite(item.longitude) ? item.longitude : null,
    thumbUrl: `/media/thumb/${item.id}?v=${version}`,
    viewUrl: `/media/view/${item.id}?v=${version}`,
    fileUrl: `/media/file/${item.id}?v=${version}`,
  };
  const motion = publicLiveUrl(item);
  if (motion) publicItem.liveUrl = motion;
  return publicItem;
}

function toPublicAlbum(album) {
  return {
    id: album.id,
    title: album.title,
    kind: album.kind,
    photoCount: album.photoCount,
    videoCount: album.videoCount,
    coverItemId: album.coverItemId,
    stories: album.stories,
    items: album.items.map(toPublicItem),
  };
}

export async function computeStamp(mediaDir) {
  const rootReal = await fs.realpath(mediaDir);
  const parts = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skipEntry(entry.name) || entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const st = await fs.stat(abs);
        const rel = path.relative(rootReal, abs).split(path.sep).join('/');
        parts.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
      }
    }
  }
  await walk(rootReal);
  parts.sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

export async function scanLibrary(mediaDir) {
  const rootReal = await fs.realpath(mediaDir);
  const rootStat = await fs.stat(rootReal);
  if (!rootStat.isDirectory()) {
    const err = new Error('照片路径不是文件夹');
    err.code = 'ENOTDIR';
    throw err;
  }

  const items = await collectFiles(rootReal, rootReal);
  await attachLivePhotos(items);
  const visible = items.filter((item) => !item.liveMotion);
  const stories = await collectStories(rootReal, visible);
  const top = await fs.readdir(rootReal, { withFileTypes: true });
  const occasions = [];
  for (const entry of top) {
    if (skipEntry(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const meta = await readOccasionMeta(path.join(rootReal, entry.name));
    const named = OCCASION_RANK.has(compactName(entry.name));
    const marked = Boolean(meta && meta.occasion === true);
    if (!named && !marked) continue;
    const title = meta && typeof meta.title === 'string' && meta.title.trim()
      ? meta.title.trim().slice(0, 40)
      : entry.name;
    occasions.push({
      name: entry.name,
      title,
      rank: OCCASION_RANK.get(compactName(title)) ?? OCCASION_RANK.get(compactName(entry.name)) ?? 50,
    });
  }
  const occasionNames = new Set(occasions.map((dir) => dir.name));
  const inOccasion = (item) => {
    const topName = item.rel.split('/')[0];
    return item.rel.includes('/') && occasionNames.has(topName);
  };

  const albums = [];
  const occasionAlbums = [];
  for (const dir of occasions) {
    const group = visible.filter((item) => item.rel === dir.name || item.rel.startsWith(`${dir.name}/`));
    if (group.length === 0) continue;
    occasionAlbums.push(await makeAlbum({
      id: stableId(`occasion:${dir.name}`),
      title: dir.title,
      kind: 'occasion',
      items: group,
      stories: storiesFor(stories, group),
      rank: dir.rank,
    }));
  }
  occasionAlbums.sort((a, b) => a.rank - b.rank || b.newest - a.newest || a.title.localeCompare(b.title, 'zh'));
  albums.push(...occasionAlbums);

  const byMonth = new Map();
  for (const item of visible) {
    if (inOccasion(item)) continue;
    const key = String(item.takenAt || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(item);
  }
  const monthAlbums = [];
  for (const [key, group] of byMonth) {
    monthAlbums.push(await makeAlbum({
      id: stableId(`month:${key}`),
      title: monthTitle(key),
      kind: 'month',
      items: group,
      stories: storiesFor(stories, group),
    }));
  }
  monthAlbums.sort((a, b) => b.newest - a.newest || a.title.localeCompare(b.title, 'zh'));
  albums.push(...monthAlbums);

  const itemsById = new Map();
  for (const item of items) itemsById.set(item.id, item);

  return {
    mode: 'albums',
    albums: albums.map(toPublicAlbum),
    itemsById,
  };
}

