import fs from 'node:fs';

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function bind(stream, res) {
  const stop = () => stream.destroy();
  res.on('close', stop);
  stream.on('error', () => {
    stop();
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

export function sendFile(req, res, absPath, { contentType, cacheControl }) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'missing' }));
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'missing' }));
    return;
  }

  const size = stat.size;
  const etag = `"${Math.round(stat.mtimeMs).toString(16)}-${size.toString(16)}"`;
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl || 'private, max-age=86400',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    res.end();
    return;
  }

  if (req.headers.range) {
    const parsed = parseRange(req.headers.range, size);
    if (!parsed) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    headers['Content-Range'] = `bytes ${parsed.start}-${parsed.end}/${size}`;
    headers['Content-Length'] = parsed.end - parsed.start + 1;
    res.writeHead(206, headers);
    bind(fs.createReadStream(absPath, parsed), res);
    return;
  }

  headers['Content-Length'] = size;
  res.writeHead(200, headers);
  bind(fs.createReadStream(absPath), res);
}
