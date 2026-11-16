export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const SNAP_SCALE = 1.05;

export function isZoomed(scale) {
  return scale >= SNAP_SCALE;
}

export function clampPan(x, y, scale, width, height) {
  if (!(scale > 1) || !(width > 0) || !(height > 0)) return { scale: 1, x: 0, y: 0 };
  const minX = width * (1 - scale);
  const minY = height * (1 - scale);
  return {
    scale,
    x: Math.min(0, Math.max(minX, x)),
    y: Math.min(0, Math.max(minY, y)),
  };
}

export function pinchTo({
  startScale,
  startX,
  startY,
  startDist,
  startMid,
  mid,
  dist,
  width,
  height,
}) {
  const base = startDist > 0 ? startDist : 1;
  const raw = (startScale || 1) * (dist / base);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
  const origin = startScale > 0 ? startScale : 1;
  const contentX = (startMid.x - startX) / origin;
  const contentY = (startMid.y - startY) / origin;
  return clampPan(mid.x - contentX * scale, mid.y - contentY * scale, scale, width, height);
}

export function panBy({ startX, startY, dx, dy, scale, width, height }) {
  if (!(scale > 1)) return { scale: 1, x: 0, y: 0 };
  return clampPan(startX + dx, startY + dy, scale, width, height);
}
