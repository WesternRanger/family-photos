import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { embedJpegDate, embedJpegGps, readJpegTakenAt, scanLibrary, stableId } from '../server/library.js';

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
