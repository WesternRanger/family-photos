import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { cookieHeader, isAuthed, safeEqual } from './auth.js';
import { createCatalog } from './catalog.js';
import { addComment, changeLike } from './engagement.js';
import { sendFile } from './send.js';
import { detectTools, resolveMedia } from './thumbs.js';

const STATIC = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/favicon.svg', 'favicon.svg'],
]);

const STATIC_TYPE = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function clientIp(req) {
  return req.socket?.remoteAddress || 'local';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { code: 'LIMIT' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(req, res, status, body, contentType, extra = {}) {
  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
  const accept = req.headers['accept-encoding'] || '';
  const compressible = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('javascript') || contentType.includes('svg');
  if (compressible && body.length > 800 && accept.includes('gzip')) {
    zlib.gzip(body, (err, gz) => {
      if (err || res.headersSent) {
        if (!res.headersSent) {
          headers['Content-Length'] = body.length;
          res.writeHead(status, headers);
          res.end(body);
        }
        return;
      }
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      headers['Content-Length'] = gz.length;
      res.writeHead(status, headers);
      res.end(gz);
    });
    return;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(req, res, status, data, extra) {
  sendBuffer(req, res, status, Buffer.from(JSON.stringify(data)), 'application/json; charset=utf-8', {
    'Cache-Control': 'no-store',
    ...extra,
  });
}

async function sendStatic(req, res, config, name) {
  const file = path.join(config.root, 'public', name);
  const body = await fs.readFile(file);
  const ext = path.extname(name);
  sendBuffer(req, res, 200, body, STATIC_TYPE[ext] || 'application/octet-stream', {
    'Cache-Control': 'no-cache',
  });
}

export function createApp(config, { ttl = 60000, geocode } = {}) {
  const catalog = createCatalog(config.mediaDir, { ttl, cacheDir: config.cacheDir, geocode });
  const attempts = new Map();

  function isLocked(ip) {
    const rec = attempts.get(ip);
    return Boolean(rec && Date.now() < rec.reset && rec.n >= 8);
  }

  function recordFailure(ip) {
    const now = Date.now();
    let rec = attempts.get(ip);
    if (!rec || now > rec.reset) rec = { n: 0, reset: now + 10 * 60 * 1000 };
    rec.n += 1;
    attempts.set(ip, rec);
    if (attempts.size > 400) {
      for (const [key, value] of attempts) {
        if (now > value.reset) attempts.delete(key);
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && STATIC.has(pathname)) {
      await sendStatic(req, res, config, STATIC.get(pathname));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      const tools = await detectTools();
      sendJson(req, res, 200, {
        ok: true,
        auth: Boolean(config.accessCode),
        tools: { sips: Boolean(tools.sips), ffmpeg: Boolean(tools.ffmpeg) },
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/unlock') {
      if (!config.accessCode) {
        sendJson(req, res, 200, { ok: true });
        return;
      }
      const ip = clientIp(req);
      if (isLocked(ip)) {
        sendJson(req, res, 429, { error: 'locked', message: '试得太多了，请过几分钟再试。' });
        return;
      }
      let payload = {};
      try {
        const raw = await readBody(req, 2048);
        payload = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        sendJson(req, res, 400, { error: 'bad_request', message: '没有看懂。' });
        return;
      }
      const code = typeof payload.code === 'string' ? payload.code.trim() : '';
      if (!safeEqual(code, config.accessCode)) {
        recordFailure(ip);
        sendJson(req, res, 401, { error: 'bad_code', message: '查看码不对，请再试一次。' });
        return;
      }
      attempts.delete(ip);
      sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(config.accessCode) });
      return;
    }

    const media = pathname.match(/^\/media\/(thumb|view|file)\/([a-f0-9]{16})$/);
    if (media) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(req, res, 405, { error: 'method' });
        return;
      }
      if (!isAuthed(req, config)) {
        sendJson(req, res, 401, { error: 'need_code', message: '请输入查看码' });
        return;
      }
      let lib;
      try {
        lib = await catalog.get();
      } catch (err) {
        const status = err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 404 : 500;
        sendJson(req, res, status, { error: 'media_dir_missing', message: '还没有找到照片文件夹。' });
        return;
      }
      const item = lib.itemsById.get(media[2]);
      if (!item) {
        sendJson(req, res, 404, { error: 'missing', message: '没有这张照片。' });
        return;
      }
      const resolved = await resolveMedia(item, media[1], config);
      if (!resolved) {
        sendJson(req, res, 404, { error: 'thumb_failed', message: '这张暂时显示不了。' });
        return;
      }
      const versioned = url.searchParams.has('v');
      sendFile(req, res, resolved.file, {
        contentType: resolved.contentType,
        cacheControl: versioned ? 'public, max-age=31536000, immutable' : 'private, max-age=86400',
      });
      return;
    }

    if (req.method === 'POST' && (pathname === '/api/like' || pathname === '/api/comment')) {
      if (!isAuthed(req, config)) {
        sendJson(req, res, 401, { error: 'need_code', message: '请输入查看码' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req, 8000));
      } catch {
        sendJson(req, res, 400, { error: 'bad_json', message: '没听清，请再试一次。' });
        return;
      }
      const id = payload && typeof payload.id === 'string' ? payload.id : '';
      if (!/^[a-f0-9]{16}$/.test(id)) {
        sendJson(req, res, 400, { error: 'bad_id', message: '没有这张照片。' });
        return;
      }
      let lib;
      try {
        lib = await catalog.get();
      } catch {
        sendJson(req, res, 404, { error: 'missing', message: '没有这张照片。' });
        return;
      }
      const item = lib.itemsById.get(id);
      if (!item) {
        sendJson(req, res, 404, { error: 'missing', message: '没有这张照片。' });
        return;
      }
      if (pathname === '/api/like') {
        const saved = await changeLike(item, payload.on === true);
        await catalog.remember(item.id, saved);
        sendJson(req, res, 200, { likes: saved.likes });
        return;
      }
      const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 200) : '';
      if (!text) {
        sendJson(req, res, 400, { error: 'empty', message: '先写一句吧。' });
        return;
      }
      const entry = { id: crypto.randomBytes(6).toString('hex'), text, at: new Date().toISOString() };
      const saved = await addComment(item, entry);
      await catalog.remember(item.id, saved);
      sendJson(req, res, 200, { comments: saved.comments });
      return;
    }

    if (req.method === 'GET' && (pathname === '/api/albums' || pathname === '/api/library')) {
      if (!isAuthed(req, config)) {
        sendJson(req, res, 401, { error: 'need_code', message: '请输入查看码' });
        return;
      }
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      try {
        const page = await catalog.page(offset, limit);
        sendJson(req, res, 200, {
          version: 1,
          title: config.title,
          mode: 'albums',
          ...page,
        });
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          sendJson(req, res, 404, {
            error: 'media_dir_missing',
            message: '还没有找到照片文件夹。请在电脑上把 MEDIA_DIR 指到放照片的文件夹，然后重启服务。',
          });
          return;
        }
        throw err;
      }
      return;
    }

    const placePath = pathname.match(/^\/api\/place\/([a-f0-9]{16})$/);
    if (req.method === 'GET' && placePath) {
      if (!isAuthed(req, config)) {
        sendJson(req, res, 401, { error: 'need_code', message: '请输入查看码' });
        return;
      }
      try {
        const found = await catalog.place(placePath[1]);
        if (!found) {
          sendJson(req, res, 404, { error: 'missing', message: '没有这张照片。' });
          return;
        }
        sendJson(req, res, 200, found);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          sendJson(req, res, 404, { error: 'media_dir_missing', message: '还没有找到照片文件夹。' });
          return;
        }
        throw err;
      }
      return;
    }

    const albumPath = pathname.match(/^\/api\/album\/([a-f0-9]{16})$/);
    if (req.method === 'GET' && albumPath) {
      if (!isAuthed(req, config)) {
        sendJson(req, res, 401, { error: 'need_code', message: '请输入查看码' });
        return;
      }
      try {
        const album = await catalog.album(albumPath[1]);
        if (!album) {
          sendJson(req, res, 404, { error: 'missing', message: '没有这个相册。' });
          return;
        }
        sendJson(req, res, 200, album);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          sendJson(req, res, 404, { error: 'media_dir_missing', message: '还没有找到照片文件夹。' });
          return;
        }
        throw err;
      }
      return;
    }

    sendJson(req, res, 404, { error: 'not_found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        sendJson(req, res, 500, { error: 'server', message: '服务暂时出错了。' });
      } else {
        res.end();
      }
    });
  });
}
