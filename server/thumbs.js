import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const BROWSER_STILL = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

let toolsPromise = null;
const inflight = new Map();

function which(cmd) {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout).trim().split('\n')[0] || null);
    });
  });
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findBin(cmd, candidates) {
  const fromPath = await which(cmd);
  if (fromPath && await fileExists(fromPath)) return fromPath;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

export function detectTools() {
  if (!toolsPromise) {
    toolsPromise = (async () => ({
      sips: await findBin('sips', ['/usr/bin/sips', '/usr/local/bin/sips']),
      ffmpeg: await findBin('ffmpeg', [
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/usr/bin/ffmpeg',
      ]),
    }))();
  }
  return toolsPromise;
}

export function resetToolsCache() {
  toolsPromise = null;
}

class Queue {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.pending = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.pending.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          this.active -= 1;
          this.pump();
        }
      });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.limit && this.pending.length > 0) {
      this.active += 1;
      const job = this.pending.shift();
      job();
    }
  }
}

const queue = new Queue(2);
const logged = new Set();

function logOnce(id, err) {
  if (logged.has(id)) return;
  logged.add(id);
  console.error(`缩略图失败 ${id}: ${err.message}`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 25000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().split('\n').slice(-2).join(' ');
        reject(new Error(`${path.basename(cmd)} 退出 ${code}${tail ? `: ${tail}` : ''}`));
      }
    });
  });
}

function dedupe(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = fn().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function fresh(out, item) {
  try {
    const [st, meta] = await Promise.all([
      fs.stat(out),
      fs.readFile(`${out}.meta`, 'utf8'),
    ]);
    return st.size > 80 && meta.trim() === `${Math.round(item.mtimeMs)}:${item.size}`;
  } catch {
    return false;
  }
}

async function finish(tmp, out, item) {
  await fs.rename(tmp, out);
  await fs.writeFile(`${out}.meta`, `${Math.round(item.mtimeMs)}:${item.size}`);
  return out;
}

async function generateStill(source, out, size) {
  const tools = await detectTools();
  const tmp = `${out}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp.jpg`;
  await fs.mkdir(path.dirname(out), { recursive: true });
  try {
    if (tools.sips) {
      await run(tools.sips, [
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', '72',
        '-Z', String(size),
        source,
        '--out', tmp,
      ]);
    } else if (tools.ffmpeg) {
      await run(tools.ffmpeg, [
        '-y', '-threads', '1', '-i', source, '-frames:v', '1',
        '-vf', `scale='min(${size},iw)':-2`,
        '-q:v', '4', tmp,
      ]);
    } else {
      throw new Error('没有 sips 或 ffmpeg');
    }
    return tmp;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function generatePoster(source, out, size) {
  const tools = await detectTools();
  if (!tools.ffmpeg) throw new Error('没有 ffmpeg，不能做视频封面');
  const tmp = `${out}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp.jpg`;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const vf = `scale='min(${size},iw)':-2`;
  const base = ['-y', '-threads', '1', '-i', source, '-frames:v', '1', '-vf', vf, '-q:v', '4', tmp];
  try {
    try {
      await run(tools.ffmpeg, ['-y', '-threads', '1', '-ss', '0.4', '-i', source, '-frames:v', '1', '-vf', vf, '-q:v', '4', tmp]);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      await run(tools.ffmpeg, base);
    }
    return tmp;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function canPassthrough(item, variant) {
  if (!BROWSER_STILL.has(item.ext)) return false;
  const limit = variant === 'thumb' ? 1_500_000 : 12_000_000;
  return item.size <= limit;
}

async function ensureGenerated(item, out, produce) {
  if (await fresh(out, item)) return out;
  return dedupe(out, () => queue.run(async () => {
    if (await fresh(out, item)) return out;
    const tmp = await produce();
    return finish(tmp, out, item);
  }));
}

export async function resolveMedia(item, variant, config) {
  if (variant === 'file' || (item.ext === '.gif' && variant === 'view')) {
    return { file: item.abs, contentType: item.ext === '.gif' ? 'image/gif' : mimeOf(item) };
  }

  if (item.kind === 'video') {
    if (variant === 'file') return { file: item.abs, contentType: mimeOf(item) };
    const out = path.join(config.cacheDir, 'posters', `${item.id}-${config.thumbSize}.jpg`);
    try {
      const file = await ensureGenerated(item, out, () => generatePoster(item.abs, out, config.thumbSize));
      return { file, contentType: 'image/jpeg' };
    } catch (err) {
      logOnce(item.id, err);
      return null;
    }
  }

  const size = variant === 'thumb' ? config.thumbSize : config.viewerSize;
  const out = path.join(config.cacheDir, variant === 'thumb' ? 'thumbs' : 'viewer', `${item.id}-${size}.jpg`);
  try {
    const file = await ensureGenerated(item, out, () => generateStill(item.abs, out, size));
    return { file, contentType: 'image/jpeg' };
  } catch (err) {
    logOnce(`${item.id}:${variant}`, err);
    if (variant !== 'thumb' && canPassthrough(item, variant)) {
      return { file: item.abs, contentType: mimeOf(item) };
    }
    return null;
  }
}

function mimeOf(item) {
  const map = {
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
  return map[item.ext] || 'application/octet-stream';
}
