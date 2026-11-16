import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createApp } from '../server/app.js';
import { rootDir } from '../server/config.js';

const execFileAsync = promisify(execFile);

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function makePhoto(file) {
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=0xc45c46:s=320x240', '-frames:v', '1', file,
  ], { stdio: 'ignore' });
}

test('library, thumbnails, and video byte ranges', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-media-http-'));
  const cache = path.join(dir, 'cache');
  const media = path.join(dir, 'media');
  await fs.mkdir(path.join(media, '春天'), { recursive: true });
  await makePhoto(path.join(media, '春天', '窗边.jpg'));
  await fs.writeFile(path.join(media, '春天', '片段.mp4'), Buffer.from('0123456789video-bytes-for-range'));
  const server = createApp({
    root: rootDir,
    host: '127.0.0.1',
    port: 0,
    mediaDir: media,
    cacheDir: cache,
    accessCode: '',
    thumbSize: 120,
    viewerSize: 160,
    title: '荞荞的照片',
  }, { ttl: 0 });
  const port = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /荞荞的照片/);

  const libraryRes = await fetch(`${base}/api/albums?offset=0&limit=3`);
  assert.equal(libraryRes.status, 200);
  const library = await libraryRes.json();
  assert.equal(library.mode, 'albums');
  assert.equal(library.total, 1);
  assert.equal(library.albums.length, 1);
  assert.equal(library.albums[0].kind, 'month');
  assert.equal(library.albums[0].photoCount, 1);
  assert.equal(library.albums[0].videoCount, 1);
  assert.equal(library.albums[0].items, undefined);
  assert.match(library.albums[0].cover.thumbUrl, /^\/media\/thumb\//);
  assert.equal(JSON.stringify(library).includes('fileUrl'), false);
  assert.equal(JSON.stringify(library).includes(media), false);

  const albumRes = await fetch(`${base}/api/album/${library.albums[0].id}`);
  const album = await albumRes.json();
  assert.equal(album.items.every((item) => item.likes === 0 && item.comments.length === 0), true);
  assert.deepEqual(album.stories, []);

  const photo = album.items.find((item) => item.kind === 'photo');
  const video = album.items.find((item) => item.kind === 'video');
  const thumb = await fetch(`${base}${photo.thumbUrl}`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  const thumbBytes = Buffer.from(await thumb.arrayBuffer());
  assert.equal(thumbBytes[0], 0xff);
  assert.equal(thumbBytes[1], 0xd8);
  const again = await fetch(`${base}${photo.thumbUrl}`, { headers: { 'If-None-Match': thumb.headers.get('etag') } });
  assert.equal(again.status, 304);

  const original = await fs.readFile(path.join(media, '春天', '窗边.jpg'));
  const full = await fetch(`${base}${photo.fileUrl}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const fullBytes = Buffer.from(await full.arrayBuffer());
  assert.equal(fullBytes.equals(original), true);
  assert.equal(thumbBytes.equals(original), false);

  const script = await fetch(`${base}/app.js`);
  const source = await script.text();
  assert.match(source, /img\.src = item\.thumbUrl/);
  assert.match(source, /return item\.viewUrl \|\| item\.fileUrl/);
  assert.match(source, /video\.src = item\.fileUrl/);
  assert.match(source, /preview\.hidden = true/);
  assert.match(source, /preview\.className = 'preview'/);
  assert.match(source, /el\('div', 'spinner'\)/);
  assert.match(source, /placeSlides/);
  assert.match(source, /\/api\/albums\?offset=/);
  assert.match(source, /const BATCH = 3/);
  assert.match(source, /加载更多/);
  assert.match(source, /没有更多了/);
  assert.doesNotMatch(source, /IntersectionObserver/);
  assert.doesNotMatch(source, /warm\(item\.fileUrl\)/);
  assert.doesNotMatch(source, /img\.src = item\.fileUrl/);
  assert.doesNotMatch(source, /big-play/);
  assert.match(source, /video\.controls = true/);
  assert.match(source, /video\.controls = false/);
  assert.match(source, /lockPageScroll/);
  assert.match(source, /pinchTo/);
  assert.match(source, /item\.liveUrl/);
  assert.match(source, /播放实况/);
  const zoomScript = await fetch(`${base}/zoom.js`);
  assert.equal(zoomScript.status, 200);
  assert.match(zoomScript.headers.get('content-type') || '', /javascript/);

  const ranged = await fetch(`${base}${video.fileUrl}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers.get('content-range'), /^bytes 0-9\//);
  assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), '0123456789');

  const beforeCover = library.albums[0].cover.id;
  const target = album.items.find((item) => item.id !== beforeCover);
  const liked = await fetch(`${base}/api/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: target.id, on: true }),
  });
  assert.equal(liked.status, 200);
  assert.equal((await liked.json()).likes, 1);
  const noted = path.join(media, '春天', 'comments', `${target.kind === 'photo' ? '窗边' : '片段'}.json`);
  const saved = JSON.parse(await fs.readFile(noted, 'utf8'));
  assert.equal(saved.likes, 1);
  assert.equal(path.basename(noted), target.kind === 'photo' ? '窗边.json' : '片段.json');
  const commented = await fetch(`${base}/api/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: target.id, text: '真好看' }),
  });
  assert.equal(commented.status, 200);
  const withNote = JSON.parse(await fs.readFile(noted, 'utf8'));
  assert.equal(withNote.comments[0].text, '真好看');
  const emojiNote = await fetch(`${base}/api/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: target.id, text: '❤️' }),
  });
  assert.equal(emojiNote.status, 200);
  const withEmoji = JSON.parse(await fs.readFile(noted, 'utf8'));
  assert.equal(withEmoji.comments[1].text, '❤️');
  const refreshed = await (await fetch(`${base}/api/albums?offset=0&limit=3`)).json();
  assert.equal(refreshed.albums[0].cover.id, target.id);
  assert.equal(refreshed.albums[0].items, undefined);
  const emptyNote = await fetch(`${base}/api/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: target.id, text: '   ' }),
  });
  assert.equal(emptyNote.status, 400);

  const missing = await fetch(`${base}/media/file/aaaaaaaaaaaaaaaa`);
  assert.equal(missing.status, 404);
  const escape = await fetch(`${base}/media/file/..%2f..%2fetc%2fpasswd`);
  assert.equal(escape.status, 404);
});

test('access code stays off the photo routes until it matches', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-media-auth-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const server = createApp({
    root: rootDir,
    host: '127.0.0.1',
    port: 0,
    mediaDir: dir,
    cacheDir: path.join(dir, 'cache'),
    accessCode: '家里',
    thumbSize: 200,
    viewerSize: 400,
    title: '荞荞的照片',
  });
  const port = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const locked = await fetch(`${base}/api/albums`);
  assert.equal(locked.status, 401);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const wrong = await fetch(`${base}/api/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '不对' }),
  });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${base}/api/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '家里' }),
  });
  assert.equal(right.status, 200);
  const cookie = right.headers.get('set-cookie');
  assert.match(cookie, /fm_auth=/);
  const opened = await fetch(`${base}/api/albums?offset=0&limit=3`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(opened.status, 200);
  const body = await opened.json();
  assert.equal(body.albums[0].items, undefined);
  const detail = await fetch(`${base}/api/album/${body.albums[0].id}`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).items.length, 1);
});

test('homepage pages three covers and does not rescan when the index is warm', async () => {
  const { createCatalog } = await import('../server/catalog.js');
  const { embedJpegDate } = await import('../server/library.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-media-page-'));
  const media = path.join(dir, 'media');
  const cache = path.join(dir, 'cache');
  await fs.mkdir(media);
  try {
    for (const date of ['2024-01-02', '2024-02-02', '2024-03-02', '2024-04-02', '2024-04-20']) {
      await fs.writeFile(
        path.join(media, `${date}.jpg`),
        embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), date),
      );
    }
    const first = createCatalog(media, { ttl: 0, cacheDir: cache });
    const page = await first.page(0, 100);
    assert.equal(page.total, 4);
    assert.equal(page.limit, 3);
    assert.deepEqual(page.albums.map((album) => album.title), ['2024年4月', '2024年3月', '2024年2月']);
    const april = await first.album(page.albums[0].id);
    const oldest = april.items.find((item) => item.takenAt === '2024-04-02');
    assert.equal(page.albums[0].cover.id, oldest.id);
    assert.match(page.albums[0].cover.thumbUrl, /^\/media\/thumb\//);
    assert.equal(page.albums.every((album) => album.items === undefined && album.cover.thumbUrl.startsWith('/media/thumb/')), true);
    const rest = await first.page(3, 3);
    assert.equal(rest.albums.length, 1);
    assert.equal(rest.albums[0].title, '2024年1月');
    assert.equal(first.stats.scans, 1);
    const second = createCatalog(media, { ttl: 0, cacheDir: cache });
    const again = await second.page(0, 3);
    assert.equal(again.albums[0].title, '2024年4月');
    assert.equal(second.stats.scans, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('demo media is ready to open', async () => {
  const { scanLibrary } = await import('../server/library.js');
  const lib = await scanLibrary(path.join(rootDir, 'demo-media'));
  assert.equal(lib.mode, 'albums');
  const titles = lib.albums.map((album) => album.title);
  assert.equal(titles.includes('满月'), true);
  assert.equal(titles.includes('100天'), true);
  assert.equal(titles.includes('6个月'), true);
  assert.equal(titles.includes('2026年10月'), true);
  assert.equal(titles.includes('全部'), false);
  const all = lib.albums.flatMap((album) => album.items);
  assert.equal(all.filter((item) => item.kind === 'photo').length >= 4, true);
  assert.equal(all.some((item) => item.kind === 'video'), true);
  const october = lib.albums.find((album) => album.title === '2026年10月');
  assert.ok(Math.abs(october.items[0].latitude - 31.23) < 0.02);
  assert.ok(Math.abs(october.items[0].longitude - 121.47) < 0.02);
  assert.equal(october.items[0].place, undefined);
  assert.equal(JSON.stringify(october).includes('北纬'), false);
  const live = all.filter((item) => item.liveUrl);
  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'photo');
  assert.match(live[0].liveUrl, /^\/media\/live\//);
  const motion = [...lib.itemsById.values()].filter((item) => item.liveMotion);
  assert.equal(motion.length, 1);
  assert.equal(motion[0].kind, 'video');
  assert.equal(all.some((item) => item.id === motion[0].id), false);
});

test('live photo plays from the still and a plain photo has no motion route', async (t) => {
  const { createCatalog } = await import('../server/catalog.js');
  const { embedJpegDate } = await import('../server/library.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-media-live-http-'));
  const media = path.join(dir, 'media');
  const cache = path.join(dir, 'cache');
  await fs.mkdir(media);
  const clip = Buffer.from('free-live-clip-bytes-0123456789');
  const marked = Buffer.concat([
    Buffer.from('com.apple.quicktime.still-image-time\0'),
    clip,
  ]);
  const video = Buffer.alloc(32, 0x2a);
  video.write('ftyp', 4);
  const embedded = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from(`GCamera:MicroVideo="1" GCamera:MicroVideoOffset="${video.length}"`),
    Buffer.from([0xff, 0xd9]),
    video,
  ]);
  await fs.writeFile(path.join(media, 'plain.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-05-01'));
  await fs.writeFile(path.join(media, 'wave.jpg'), embedJpegDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '2026-05-02'));
  await fs.writeFile(path.join(media, 'wave.mov'), marked);
  await fs.writeFile(path.join(media, '散步.mp4'), Buffer.from('0123456789video'));
  await fs.writeFile(path.join(media, 'motion.jpg'), embedJpegDate(embedded, '2026-05-03'));
  const server = createApp({
    root: rootDir,
    host: '127.0.0.1',
    port: 0,
    mediaDir: media,
    cacheDir: cache,
    accessCode: '',
    thumbSize: 120,
    viewerSize: 160,
    title: '荞荞的照片',
  }, { ttl: 0 });
  const port = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const home = await (await fetch(`${base}/api/albums?offset=0&limit=3`)).json();
  assert.equal(home.albums.reduce((sum, album) => sum + album.photoCount, 0), 3);
  assert.equal(home.albums.reduce((sum, album) => sum + album.videoCount, 0), 1);
  const albums = [];
  for (const summary of home.albums) {
    albums.push(await (await fetch(`${base}/api/album/${summary.id}`)).json());
  }
  const items = albums.flatMap((album) => album.items);
  const plain = items.find((item) => item.takenAt === '2026-05-01');
  const wave = items.find((item) => item.takenAt === '2026-05-02');
  const motionItem = items.find((item) => item.takenAt === '2026-05-03');
  const regular = items.find((item) => item.kind === 'video');
  assert.equal(items.length, 4);
  assert.equal(plain.liveUrl, undefined);
  assert.match(wave.liveUrl, /^\/media\/live\//);
  assert.match(motionItem.liveUrl, /^\/media\/live\//);
  assert.equal(regular.liveUrl, undefined);
  const played = await fetch(`${base}${wave.liveUrl}`);
  assert.equal(played.status, 200);
  assert.equal(played.headers.get('content-type'), 'video/quicktime');
  assert.equal(Buffer.from(await played.arrayBuffer()).equals(marked), true);
  const ranged = await fetch(`${base}${wave.liveUrl}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), marked.subarray(0, 4).toString());
  const embeddedRes = await fetch(`${base}${motionItem.liveUrl}`);
  assert.equal(embeddedRes.status, 200);
  assert.equal(embeddedRes.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await embeddedRes.arrayBuffer()).equals(video), true);
  const noMotion = await fetch(`${base}/media/live/${plain.id}`);
  assert.equal(noMotion.status, 404);
  const catalog = createCatalog(media, { ttl: 0, cacheDir: cache });
  const may = home.albums.find((album) => album.photoCount === 3);
  const again = await catalog.album(may.id);
  assert.equal(catalog.stats.scans, 0);
  assert.match(again.items.find((item) => item.takenAt === '2026-05-02').liveUrl, /^\/media\/live\//);
  assert.equal(again.items.find((item) => item.takenAt === '2026-05-01').liveUrl, undefined);
  assert.equal(again.videoCount, 0);
  const november = await catalog.album(home.albums.find((album) => album.videoCount === 1).id);
  assert.equal(november.items.some((item) => item.kind === 'video'), true);
});
