import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function applyEnvFile(file, env) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function resolveDir(value, fallback, root) {
  const raw = value && String(value).trim() ? String(value).trim() : fallback;
  return path.resolve(root, raw);
}

export function loadConfig({ env = process.env, root = rootDir, loadFile = true } = {}) {
  if (loadFile) applyEnvFile(path.join(root, '.env'), env);
  const port = clamp(env.PORT, 1, 65535, 4721);
  const mediaValue = env.MEDIA_DIR || env.PHOTOS_DIR;
  return {
    root,
    host: (env.HOST || '0.0.0.0').trim() || '0.0.0.0',
    port,
    mediaDir: resolveDir(mediaValue, path.join(root, 'demo-media'), root),
    cacheDir: resolveDir(env.CACHE_DIR, path.join(root, 'cache'), root),
    accessCode: (env.ACCESS_CODE || '').trim(),
    thumbSize: clamp(env.THUMB_SIZE, 320, 1600, 800),
    viewerSize: clamp(env.VIEWER_SIZE, 640, 3200, 1920),
    title: '荞荞的照片',
  };
}
