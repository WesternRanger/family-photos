import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  embedJpegDate,
  embedJpegGps,
  findEmbeddedMotion,
  readJpegTakenAt,
  readLiveMarkers,
  scanLibrary,
  stableId,
} from '../server/library.js';

test('jpeg exif date round-trips and prefers DateTimeOriginal', () => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const stamped = embedJpegDate(plain, '2019-04-05');
  const found = readJpegTakenAt(stamped);
  assert.equal(found.takenAt, '2019-04-05');
  assert.equal(new Date(found.sortAt).getFullYear(), 2019);
  assert.equal(embedJpegDate(stamped, '2020-01-01').equals(stamped), true);
  assert.equal(readJpegTakenAt(stamped).latitude ?? null, null);
  assert.equal(readJpegTakenAt(stamped).longitude ?? null, null);
});

test('jpeg gps is read back and not invented when absent', () => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const stamped = embedJpegGps(plain, '2026-10-20', 31.23, 121.47);
  const found = readJpegTakenAt(stamped);
  assert.equal(found.takenAt, '2026-10-20');
  assert.ok(Math.abs(found.latitude - 31.23) < 0.001);
  assert.ok(Math.abs(found.longitude - 121.47) < 0.001);
  assert.equal(JSON.stringify(found).includes('北纬'), false);
  const south = readJpegTakenAt(embedJpegGps(plain, '2026-01-08', -33.87, 151.21));
  assert.ok(Math.abs(south.latitude + 33.87) < 0.001);
  assert.ok(Math.abs(south.longitude - 151.21) < 0.001);
});

test('plain folders become months and keep stories for later', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-media-'));
  try {
    const child = path.join(dir, '荞荞');
    const nested = path.join(child, '春天');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, '公园.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2024-05-01'));
    await fs.writeFile(path.join(child, '近照.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-08-01'));
    await fs.writeFile(path.join(child, '.hidden.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await fs.writeFile(path.join(child, '笔记.txt'), 'not media');
    await fs.writeFile(path.join(dir, '门口.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2025-01-01'));
    const outside = path.join(os.tmpdir(), `family-media-outside-${process.pid}.jpg`);
    await fs.writeFile(outside, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await fs.symlink(outside, path.join(child, '越界.jpg'));
    await fs.writeFile(path.join(child, 'stories.json'), JSON.stringify([
      { date: '2026-08-01', text: '今天骑了车。', media: ['近照.jpg'] },
      { text: '' },
    ]));
    await fs.mkdir(path.join(dir, '空相册'));

    const lib = await scanLibrary(dir);
    assert.equal(lib.mode, 'albums');
    assert.deepEqual(lib.albums.map((album) => album.title), ['2026年8月', '2025年1月', '2024年5月']);
    const album = lib.albums[0];
    assert.equal(album.kind, 'month');
    assert.equal(album.photoCount, 1);
    assert.equal(album.items[0].takenAt, '2026-08-01');
    assert.equal(album.stories.length, 1);
    assert.equal(album.stories[0].text, '今天骑了车。');
    assert.equal(album.stories[0].mediaIds[0], album.items[0].id);
    assert.equal(lib.albums[1].items[0].takenAt, '2025-01-01');
    assert.equal(lib.albums[2].items[0].takenAt, '2024-05-01');
    const dumped = JSON.stringify(lib.albums);
    assert.equal(dumped.includes(dir), false);
    assert.equal(album.items[0].id, stableId('item:荞荞/近照.jpg'));
    await fs.rm(outside, { force: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a folder of files becomes one month, and occasions stay separate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-media-flat-'));
  try {
    await fs.writeFile(path.join(dir, 'a.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-02-02'));
    await fs.writeFile(path.join(dir, 'b.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-02-04'));
    const fullMoon = path.join(dir, '满月');
    await fs.mkdir(fullMoon);
    await fs.writeFile(path.join(fullMoon, 'c.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-02-01'));
    const custom = path.join(dir, '院子');
    await fs.mkdir(custom);
    await fs.writeFile(path.join(custom, 'album.json'), JSON.stringify({ occasion: true, title: '第一次走路' }));
    await fs.writeFile(path.join(custom, 'd.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-02-03'));
    const lib = await scanLibrary(dir);
    assert.equal(lib.mode, 'albums');
    assert.deepEqual(lib.albums.map((album) => album.title), ['满月', '第一次走路', '2026年2月']);
    assert.equal(lib.albums[0].kind, 'occasion');
    assert.equal(lib.albums[0].items.length, 1);
    assert.equal(lib.albums[1].kind, 'occasion');
    assert.equal(lib.albums[2].kind, 'month');
    assert.deepEqual(lib.albums[2].items.map((item) => item.takenAt), ['2026-02-04', '2026-02-02']);
    assert.equal(lib.albums.some((album) => album.title === '全部'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function freeAtom(payload) {
  const body = Buffer.concat([Buffer.from('free'), Buffer.from(payload)]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length + 4);
  return Buffer.concat([size, body]);
}

function liveClip({ stillTime = false, contentId = '' } = {}) {
  const parts = [];
  if (stillTime) parts.push('com.apple.quicktime.still-image-time');
  if (contentId) parts.push(`com.apple.quicktime.content.identifier ${contentId}`);
  return freeAtom(parts.join('\0'));
}

test('live photo markers and embedded motion are explicit', () => {
  const id = 'B7E2C1A0-5D44-4F18-9A6E-0C1D2E3F4A5B';
  const marked = readLiveMarkers(liveClip({ stillTime: true, contentId: id }));
  assert.equal(marked.stillImageTime, true);
  assert.equal(marked.contentId, id);
  assert.equal(readLiveMarkers(Buffer.from('not a live photo')).stillImageTime, false);
  assert.equal(readLiveMarkers(Buffer.from('not a live photo')).contentId, '');

  const video = Buffer.alloc(40);
  video.write('ftyp', 4);
  const xmp = `<rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" GCamera:MicroVideo="1" GCamera:MicroVideoOffset="${video.length}" Item:Length="0"/>`;
  const file = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(xmp), Buffer.from([0xff, 0xd9]), video]);
  const found = findEmbeddedMotion(file);
  assert.equal(found.length, video.length);
  assert.equal(file.subarray(found.offset).equals(video), true);
  assert.equal(findEmbeddedMotion(Buffer.concat([Buffer.from([0xff, 0xd8]), video])), null);
  const flagged = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from('GCamera:MicroVideo="1" GCamera:MicroVideoOffset="40"'),
    Buffer.from([0xff, 0xd9]),
    Buffer.alloc(40, 1),
  ]);
  assert.equal(findEmbeddedMotion(flagged), null);
});

test('live photos pair a still with its motion clip and leave ordinary videos alone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-media-live-'));
  const id = 'B7E2C1A0-5D44-4F18-9A6E-0C1D2E3F4A5B';
  const otherId = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  try {
    const jpeg = (name, extra = '') => fs.writeFile(
      path.join(dir, name),
      Buffer.concat([
        embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-03-03'),
        Buffer.from(extra),
      ]),
    );
    await jpeg('plain.jpg');
    await fs.writeFile(path.join(dir, 'movie.mp4'), Buffer.from('regular-video'));
    await jpeg('twin.jpg');
    await fs.writeFile(path.join(dir, 'twin.mp4'), Buffer.from('same-name-but-not-live'));
    await jpeg('wave.jpg');
    await fs.writeFile(path.join(dir, 'wave.mov'), liveClip({ stillTime: true }));
    await fs.writeFile(path.join(dir, 'park.HEIC'), Buffer.from(`ContentIdentifier="${id}"`));
    await fs.writeFile(path.join(dir, 'park.MOV'), liveClip({ contentId: id }));
    await jpeg('other.jpg', `ContentIdentifier="${id}"`);
    await fs.writeFile(path.join(dir, 'other.mov'), liveClip({ stillTime: true, contentId: otherId }));
    await jpeg('tagged.jpg', `ContentIdentifier="${id}"`);
    await fs.writeFile(path.join(dir, 'tagged.mp4'), Buffer.from('short-export-without-marker'));
    await jpeg('huge.jpg', `ContentIdentifier="${id}"`);
    const huge = path.join(dir, 'huge.mov');
    await fs.writeFile(huge, Buffer.from('long-movie'));
    await fs.truncate(huge, 41 * 1024 * 1024);
    const video = Buffer.alloc(36);
    video.write('ftyp', 4);
    const motion = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from(`GCamera:MotionPhoto="1" Item:Length="0" Item:Length="${video.length}"`),
      Buffer.from([0xff, 0xd9]),
      video,
    ]);
    await fs.writeFile(path.join(dir, 'motion.jpg'), embedJpegDate(motion, '2026-03-03'));

    const lib = await scanLibrary(dir);
    const albumItems = lib.albums.flatMap((album) => album.items);
    const byName = new Map([...lib.itemsById.values()].map((item) => [item.rel, item]));
    const shown = new Set(albumItems.map((item) => item.id));
    assert.equal(lib.albums.reduce((sum, album) => sum + album.photoCount, 0), 8);
    assert.equal(lib.albums.reduce((sum, album) => sum + album.videoCount, 0), 4);
    assert.equal(shown.has(byName.get('plain.jpg').id), true);
    assert.equal(byName.get('plain.jpg').liveVideoId, undefined);
    assert.equal(albumItems.find((item) => item.id === byName.get('plain.jpg').id).liveUrl, undefined);
    assert.equal(shown.has(byName.get('movie.mp4').id), true);
    assert.equal(shown.has(byName.get('twin.jpg').id), true);
    assert.equal(shown.has(byName.get('twin.mp4').id), true);
    assert.equal(byName.get('twin.jpg').liveVideoId, undefined);

    const wave = byName.get('wave.jpg');
    assert.equal(wave.liveVideoId, byName.get('wave.mov').id);
    assert.equal(byName.get('wave.mov').liveMotion, true);
    assert.equal(shown.has(byName.get('wave.mov').id), false);
    assert.match(albumItems.find((item) => item.id === wave.id).liveUrl, /^\/media\/live\//);

    const park = byName.get('park.HEIC');
    assert.equal(park.liveVideoId, byName.get('park.MOV').id);
    assert.equal(shown.has(byName.get('park.MOV').id), false);
    assert.equal(byName.get('other.jpg').liveVideoId, undefined);
    assert.equal(shown.has(byName.get('other.mov').id), true);
    assert.equal(byName.get('tagged.jpg').liveVideoId, byName.get('tagged.mp4').id);
    assert.equal(shown.has(byName.get('tagged.mp4').id), false);
    assert.equal(byName.get('huge.jpg').liveVideoId, undefined);
    assert.equal(shown.has(byName.get('huge.mov').id), true);

    const embedded = byName.get('motion.jpg');
    assert.equal(embedded.liveVideoId, undefined);
    assert.equal(embedded.liveEmbedded.length, video.length);
    assert.match(albumItems.find((item) => item.id === embedded.id).liveUrl, /^\/media\/live\//);
    assert.equal(JSON.stringify(lib.albums).includes(dir), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
