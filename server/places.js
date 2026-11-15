import fs from 'node:fs/promises';
import path from 'node:path';

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isDistrictName(part) {
  if (!part || part.length > 12) return false;
  if (/(?:社区|小区|校区|园区|景区|自治区|地区|矿区)$/.test(part)) return false;
  return /[区县]$/.test(part);
}

function districtFrom(displayName, state, city) {
  const parts = String(displayName || '').split(/[，,]/).map((part) => part.trim());
  return parts.find((part) => isDistrictName(part) && part !== state && part !== city) || '';
}

/**
 * Turn a Nominatim reverse-geocode payload into one Chinese address line.
 * Returns null when the result is only a country or a province/city.
 */
export function formatChineseAddress(payload) {
  const address = payload?.address;
  if (!address || typeof address !== 'object') return null;
  const state = clean(address.state);
  const city = clean(address.city || address.municipality);
  const town = clean(address.town || address.village || address.hamlet);
  const district = clean(address.city_district || address.county || address.state_district)
    || districtFrom(payload.display_name, state, city);
  const suburb = clean(address.suburb);
  const quarter = clean(address.quarter || address.neighbourhood);
  const road = clean(address.road || address.pedestrian || address.footway);
  const number = clean(address.house_number).replace(/号$/, '');
  const poi = clean(
    address.tourism || address.leisure || address.amenity || address.building || address.shop || address.office,
  );
  const parts = [];
  const push = (value) => {
    if (!value || parts.includes(value)) return;
    parts.push(value);
  };
  push(state);
  push(city);
  push(district);
  if (town && town !== city) push(town);
  push(suburb);
  if (!road) push(quarter);
  if (road) push(number ? `${road}${number}号` : road);
  push(poi);
  const specific = Boolean(district || suburb || quarter || road || poi || town);
  if (!specific) return null;
  const text = parts.join('').slice(0, 80);
  if (!text || text === clean(address.country)) return null;
  return cleanPlace(text);
}

export function cleanPlace(place) {
  if (typeof place !== 'string') return null;
  const text = place.trim();
  if (!text) return null;
  if (/[南北]纬|[东西]经|\d+(?:\.\d+)?\s*°/.test(text)) return null;
  return text;
}

export function placeKey(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return '';
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

export function createGeocoder({
  cacheDir,
  fetchImpl = fetch,
  minIntervalMs = 1100,
  timeoutMs = 4000,
} = {}) {
  let cache = null;
  let loading = null;
  const inflight = new Map();
  let chain = Promise.resolve();
  let lastAt = 0;
  const file = cacheDir ? path.join(cacheDir, 'places.json') : '';

  async function load() {
    if (cache) return cache;
    if (loading) return loading;
    loading = (async () => {
      cache = {};
      if (!file) return cache;
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) cache = data;
      } catch {
        cache = {};
      }
      return cache;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function save() {
    if (!file || !cache) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache));
    await fs.rename(tmp, file);
  }

  function enqueue(fn) {
    const run = chain.then(async () => {
      const wait = minIntervalMs - (Date.now() - lastAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastAt = Date.now();
      return fn();
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function request(lat, lon) {
    const url = new URL(NOMINATIM);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('accept-language', 'zh-CN');
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh',
        'User-Agent': 'family-photos/1.0 (private family album)',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = await res.json();
    return formatChineseAddress(body);
  }

  async function lookup(latitude, longitude) {
    const key = placeKey(latitude, longitude);
    if (!key) return null;
    await load();
    if (cache[key] && Object.hasOwn(cache[key], 'place')) return cleanPlace(cache[key].place);
    if (inflight.has(key)) return inflight.get(key);
    const job = enqueue(async () => {
      await load();
      if (cache[key] && Object.hasOwn(cache[key], 'place')) return cleanPlace(cache[key].place);
      let place;
      try {
        place = await request(Number(key.split(',')[0]), Number(key.split(',')[1]));
      } catch {
        return null;
      }
      if (place === undefined) return null;
      cache[key] = { place };
      try { await save(); } catch { /* the answer is still in memory */ }
      return cleanPlace(place);
    }).finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function peek(latitude, longitude) {
    const key = placeKey(latitude, longitude);
    if (!key) return null;
    await load();
    if (!cache[key] || !Object.hasOwn(cache[key], 'place')) return null;
    return cleanPlace(cache[key].place);
  }

  return { lookup, peek };
}
