import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { rootDir } from '../server/config.js';
import { embedJpegDate, embedJpegGps } from '../server/library.js';
import { createGeocoder, formatChineseAddress } from '../server/places.js';

const shanghai = {
  display_name: '人民广场, 120, 人民大道, 江阴社区, 南京东路街道, 上海市, 黄浦区, 上海市, 200001, 中国',
  address: {
    leisure: '人民广场',
    house_number: '120',
    road: '人民大道',
    quarter: '江阴社区',
    suburb: '南京东路街道',
    city: '上海市',
    state: '上海市',
    postcode: '200001',
    country: '中国',
  },
};

test('chinese address keeps a specific place and drops coordinates', () => {
  assert.equal(
    formatChineseAddress(shanghai),
    '上海市黄浦区南京东路街道人民大道120号人民广场',
  );
  assert.equal(formatChineseAddress({ address: { country: '中国', city: '上海市' } }), null);
  assert.equal(formatChineseAddress({ address: { country: '中国' } }), null);
  assert.equal(formatChineseAddress({ address: { road: '北纬 31.23°' } }), null);
});

test('geocoder caches a place and does not cache a failed lookup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-places-'));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
    return {
      ok: true,
      json: async () => shanghai,
    };
  };
  try {
    const geo = createGeocoder({ cacheDir: dir, fetchImpl, minIntervalMs: 0, timeoutMs: 1000 });
    assert.equal(await geo.lookup(31.23, 121.47), null);
    assert.equal(await geo.peek(31.23, 121.47), null);
    assert.equal(await geo.lookup(31.23, 121.47), '上海市黄浦区南京东路街道人民大道120号人民广场');
    assert.equal(calls, 2);
    const again = createGeocoder({
      cacheDir: dir,
      fetchImpl: async () => { throw new Error('should not be called'); },
      minIntervalMs: 0,
    });
    assert.equal(await again.peek(31.23001, 121.47001), '上海市黄浦区南京东路街道人民大道120号人民广场');
    assert.equal(await again.lookup(31.23, 121.47), '上海市黄浦区南京东路街道人民大道120号人民广场');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('viewer place is a chinese address and coordinates stay off the album', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-place-http-'));
  const media = path.join(dir, 'media');
  await fs.mkdir(media);
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await fs.writeFile(path.join(media, 'located.jpg'), embedJpegGps(plain, '2026-10-20', 31.23, 121.47));
  await fs.writeFile(path.join(media, 'plain.jpg'), embedJpegDate(plain, '2026-10-21'));
  const server = createApp({
    root: rootDir,
    host: '127.0.0.1',
    port: 0,
    mediaDir: media,
    cacheDir: path.join(dir, 'cache'),
    accessCode: '',
    thumbSize: 120,
    viewerSize: 160,
    title: '荞荞的照片',
  }, {
    ttl: 0,
    geocode: async () => '上海市黄浦区人民大道120号人民广场',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const home = await (await fetch(`${base}/api/albums?offset=0&limit=3`)).json();
  const album = await (await fetch(`${base}/api/album/${home.albums[0].id}`)).json();
  const located = album.items.find((item) => item.takenAt === '2026-10-20');
  const plainItem = album.items.find((item) => item.takenAt === '2026-10-21');
  assert.equal(located.located, true);
  assert.equal(located.place, null);
  assert.equal(plainItem.located, false);
  assert.equal(plainItem.place, null);
  assert.equal(JSON.stringify(album).includes('latitude'), false);
  assert.equal(JSON.stringify(album).includes('北纬'), false);
  const place = await (await fetch(`${base}/api/place/${located.id}`)).json();
  assert.equal(place.place, '上海市黄浦区人民大道120号人民广场');
  const missing = await (await fetch(`${base}/api/place/${plainItem.id}`)).json();
  assert.equal(missing.place, null);
  assert.equal(JSON.stringify(place).includes('31.23'), false);
});
