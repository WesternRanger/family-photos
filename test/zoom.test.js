import assert from 'node:assert/strict';
import test from 'node:test';
import { SNAP_SCALE, isZoomed, panBy, pinchTo } from '../public/zoom.js';

test('pinch keeps the point under the fingers and stays inside 1x to 4x', () => {
  const zoomed = pinchTo({
    startScale: 1,
    startX: 0,
    startY: 0,
    startDist: 100,
    startMid: { x: 80, y: 60 },
    mid: { x: 90, y: 70 },
    dist: 200,
    width: 300,
    height: 400,
  });
  assert.equal(zoomed.scale, 2);
  assert.equal(zoomed.x, -70);
  assert.equal(zoomed.y, -50);
  assert.equal(isZoomed(zoomed.scale), true);

  const back = pinchTo({
    startScale: 2,
    startX: zoomed.x,
    startY: zoomed.y,
    startDist: 200,
    startMid: { x: 90, y: 70 },
    mid: { x: 90, y: 70 },
    dist: 40,
    width: 300,
    height: 400,
  });
  assert.equal(back.scale, 1);
  assert.deepEqual({ x: back.x, y: back.y }, { x: 0, y: 0 });
  assert.equal(isZoomed(back.scale), false);

  const capped = pinchTo({
    startScale: 3,
    startX: 0,
    startY: 0,
    startDist: 50,
    startMid: { x: 10, y: 10 },
    mid: { x: 10, y: 10 },
    dist: 400,
    width: 200,
    height: 200,
  });
  assert.equal(capped.scale, 4);
});

test('one finger pans only while zoomed and cannot drag past the photo', () => {
  assert.deepEqual(
    panBy({ startX: 0, startY: 0, dx: 30, dy: 30, scale: 1, width: 200, height: 100 }),
    { scale: 1, x: 0, y: 0 },
  );
  const moved = panBy({ startX: -10, startY: -10, dx: -25, dy: 40, scale: 2, width: 100, height: 80 });
  assert.equal(moved.scale, 2);
  assert.equal(moved.x, -35);
  assert.equal(moved.y, 0);
  const stuck = panBy({ startX: -10, startY: -10, dx: -500, dy: -500, scale: 2, width: 100, height: 80 });
  assert.equal(stuck.x, -100);
  assert.equal(stuck.y, -80);
  assert.equal(isZoomed(SNAP_SCALE - 0.01), false);
  assert.equal(isZoomed(SNAP_SCALE), true);
});
