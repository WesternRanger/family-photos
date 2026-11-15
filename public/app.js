const app = document.querySelector('#app');
const theme = document.querySelector('meta[name="theme-color"]');

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M14.5 6 8 12l6.5 6"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 7.2v9.6l8.4-4.8L9 7.2z"/></svg>';
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 20.2s-6.6-4.1-6.6-8.5a3.7 3.7 0 0 1 6.6-2.2 3.7 3.7 0 0 1 6.6 2.2c0 4.4-6.6 8.5-6.6 8.5z"/></svg>';
const EMOJI = ['❤️', '👍', '😊', '😂', '🥰', '👏', '🌹', '🎉', '👶', '😘', '🤗', '🌟'];

const BATCH = 3;
let home = { title: '荞荞的照片', total: 0, albums: [] };
let details = new Map();
let batching = false;
let routeToken = 0;
let pageKey = '';
let viewerEl = null;
let viewerItems = [];
let viewerIndex = 0;
let viewerAlbumId = '';
let pushedViewer = false;
let returnFocusId = '';
let viewerBusy = false;
let placeToken = 0;
let savedScroll = 0;
let scrollLocked = false;
const warmed = new Set();

function wrap(index, count) {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

function parseHash(hash = location.hash) {
  let raw = hash.replace(/^#/, '');
  try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'a' && parts[1]) {
    if (parts[2] === 'p') {
      return { name: 'viewer', albumId: parts[1], index: Number.parseInt(parts[3], 10) || 0 };
    }
    return { name: 'album', albumId: parts[1] };
  }
  return { name: 'home' };
}

function countText(album) {
  const parts = [];
  if (album.photoCount) parts.push(`${album.photoCount} 张照片`);
  if (album.videoCount) parts.push(`${album.videoCount} 段视频`);
  return parts.join(' · ');
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return '';
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

function readablePlace(value) {
  const place = typeof value === 'string' ? value.trim() : '';
  if (!place || /[南北]纬|[东西]经|\d+(?:\.\d+)?\s*°/.test(place)) return '';
  return place;
}

function formatWhen(item) {
  const date = formatDate(item?.takenAt);
  const place = readablePlace(item?.place);
  if (date && place) return `${date}  ${place}`;
  return date || place;
}

function stillSrc(item) {
  return item.viewUrl || item.fileUrl;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconBadge() {
  const badge = el('span', 'badge');
  badge.innerHTML = PLAY;
  badge.append(document.createTextNode('视频'));
  return badge;
}

async function fetchBatch() {
  if (batching) return 'busy';
  if (home.total && home.albums.length >= home.total) return 'done';
  batching = true;
  try {
    const res = await fetch(`/api/albums?offset=${home.albums.length}&limit=${BATCH}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401) return 'auth';
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || '没有读到照片');
    home.title = body.title || home.title;
    home.total = body.total || 0;
    const seen = new Set(home.albums.map((album) => album.id));
    for (const album of body.albums || []) {
      if (!seen.has(album.id)) home.albums.push(album);
    }
    if (parseHash().name === 'home' && home.total > 0) paintHome();
    return 'ok';
  } finally {
    batching = false;
  }
}

async function ensureAlbum(id) {
  if (details.has(id)) return details.get(id);
  const res = await fetch(`/api/album/${id}`, { headers: { Accept: 'application/json' } });
  if (res.status === 401) return { auth: true };
  if (!res.ok) return null;
  const album = await res.json();
  details.set(id, album);
  return album;
}

function showLoading() {
  app.replaceChildren();
  const page = el('main', 'page');
  page.append(el('h1', null, '荞荞的照片'), el('p', 'sub', '正在整理照片…'));
  app.append(page);
}

function showError(message) {
  closeViewer();
  app.replaceChildren();
  const page = el('main', 'page status');
  page.append(
    el('h1', null, '荞荞的照片'),
    el('p', 'sub', message || '没有连上。请确认电脑开着，手机也连着家里的 Wi-Fi。'),
  );
  const button = el('button', 'primary', '再试一次');
  button.type = 'button';
  button.style.marginTop = '22px';
  button.addEventListener('click', () => boot());
  page.append(button);
  app.append(page);
  document.title = '荞荞的照片';
}

function showGate(message) {
  closeViewer();
  pageKey = '';
  app.replaceChildren();
  const page = el('main', 'gate');
  page.append(el('h1', null, '荞荞的照片'), el('p', 'sub', '请输入查看码'));
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.type = 'text';
  input.name = 'code';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'go';
  input.setAttribute('aria-label', '查看码');
  const button = el('button', 'primary', '进入');
  button.type = 'submit';
  const warn = el('p', 'warn', message || '');
  form.append(input, button, warn);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    warn.textContent = '';
    button.disabled = true;
    try {
      const res = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: input.value.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        warn.textContent = body.message || '查看码不对，请再试一次。';
        button.disabled = false;
        input.focus();
        return;
      }
      await boot();
    } catch {
      warn.textContent = '没有连上电脑。';
      button.disabled = false;
    }
  });
  page.append(form);
  app.append(page);
  document.title = '荞荞的照片';
  input.focus();
}

function header({ title, sub, back }) {
  const head = el('header', back ? 'head is-sticky' : 'head');
  if (back) {
    const row = el('div', 'head-row');
    const button = el('button', 'back');
    button.type = 'button';
    button.innerHTML = CHEVRON;
    button.append(document.createTextNode('返回'));
    button.addEventListener('click', () => { location.hash = '#/'; });
    row.append(button);
    head.append(row);
  }
  head.append(el('h1', null, title));
  if (sub) head.append(el('p', 'sub', sub));
  return head;
}

function footer() {
  return el('p', 'foot', '只在家里的 Wi-Fi 里看，照片没有传到网上。');
}

function storySlot(album) {
  const slot = el('div');
  slot.hidden = true;
  slot.id = 'story-slot';
  slot.dataset.version = '1';
  slot.dataset.stories = JSON.stringify(album.stories || []);
  return slot;
}

function albumCard(album, index) {
  const card = el('button', 'album-card');
  card.type = 'button';
  card.dataset.albumId = album.id;
  card.setAttribute('aria-label', `${album.title}，${countText(album)}`);
  const cover = album.cover;
  if (cover?.thumbUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = cover.thumbUrl;
    img.decoding = 'async';
    if (index > 2) img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.remove();
      card.classList.add('is-broken');
    });
    card.append(img);
    if (cover.kind === 'video') card.append(iconBadge());
  }
  const meta = el('span', 'meta');
  meta.append(el('strong', null, album.title), el('em', null, countText(album)));
  card.append(meta);
  card.addEventListener('click', () => { location.hash = `#/a/${album.id}`; });
  return card;
}

function syncMore(page) {
  const more = page.querySelector('.album-more');
  const button = more.querySelector('.more-btn');
  const end = more.querySelector('.album-end');
  const done = home.total > 0 && home.albums.length >= home.total;
  button.hidden = done;
  button.disabled = batching;
  end.hidden = !done;
}

function paintHome() {
  let page = document.querySelector('.page.home');
  if (!page) {
    page = el('main', 'page home');
    page.append(header({ title: home.title || '荞荞的照片' }));
    page.append(el('div', 'album-grid'));
    const more = el('div', 'album-more');
    const button = el('button', 'more-btn', '加载更多');
    button.type = 'button';
    button.addEventListener('click', () => fetchBatch());
    const end = el('p', 'album-end', '没有更多了');
    end.hidden = true;
    more.append(button, end);
    page.append(more, footer());
    app.replaceChildren(page);
    pageKey = 'home';
  }
  const grid = page.querySelector('.album-grid');
  const have = grid.querySelectorAll('.album-card').length;
  for (let index = have; index < home.albums.length; index += 1) {
    grid.append(albumCard(home.albums[index], index));
  }
  syncMore(page);
  document.title = '荞荞的照片';
}

function renderStream(album) {
  const page = el('main', 'page');
  page.append(header({ title: album.title, back: true }));
  page.append(el('p', 'sub album-lead', `${countText(album)}。点开一张，左右接着看。`));
  const grid = el('div', 'media-grid');
  album.items.forEach((item, index) => {
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.itemId = item.id;
    tile.setAttribute('aria-label', item.kind === 'video' ? '播放视频' : '查看照片');
    const img = document.createElement('img');
    img.alt = '';
    img.src = item.thumbUrl;
    img.decoding = 'async';
    if (index > 3) img.loading = 'lazy';
    else if (index < 2) img.fetchPriority = 'high';
    img.addEventListener('error', () => {
      img.remove();
      tile.classList.add(item.kind === 'video' ? 'is-video-fallback' : 'is-broken');
      if (item.kind !== 'video') tile.append(el('span', 'tile-note', '这张没能显示'));
    });
    tile.append(img);
    if (item.kind === 'video') tile.append(iconBadge());
    tile.addEventListener('click', () => {
      if (!scrollLocked) savedScroll = window.scrollY || document.documentElement.scrollTop || 0;
      pushedViewer = true;
      returnFocusId = item.id;
      location.hash = `#/a/${album.id}/p/${index}`;
    });
    grid.append(tile);
  });
  page.append(grid, footer(), storySlot(album));
  app.replaceChildren(page);
  document.title = `${album.title} · 荞荞的照片`;
}

function renderEmpty() {
  const page = el('main', 'page status');
  page.append(
    el('h1', null, '荞荞的照片'),
    el('p', 'sub', '文件夹里还没有照片或视频。放进去之后，点下面再试一次。'),
  );
  const button = el('button', 'primary', '再试一次');
  button.type = 'button';
  button.style.marginTop = '22px';
  button.addEventListener('click', () => reload());
  page.append(button, footer());
  app.replaceChildren(page);
  document.title = '荞荞的照片';
}

function showAlbumLoading(title) {
  const page = el('main', 'page');
  page.append(header({ title: title || '荞荞的照片', back: true }));
  page.append(el('p', 'sub', '正在打开…'));
  app.replaceChildren(page);
  document.title = '荞荞的照片';
}

async function openRoute(route) {
  const token = ++routeToken;
  if (route.name === 'home') {
    closeViewer();
    if (!home.total) {
      if (pageKey !== 'empty') {
        pageKey = 'empty';
        renderEmpty();
      }
      return;
    }
    paintHome();
    return;
  }
  let album = details.get(route.albumId);
  if (!album) {
    const known = home.albums.find((entry) => entry.id === route.albumId);
    if (pageKey !== `loading:${route.albumId}`) {
      pageKey = `loading:${route.albumId}`;
      showAlbumLoading(known?.title);
    }
    album = await ensureAlbum(route.albumId);
    if (token !== routeToken) return;
  }
  if (album?.auth) {
    showGate();
    return;
  }
  if (!album || !album.items) {
    pageKey = '';
    if (home.total) paintHome();
    else renderEmpty();
    return;
  }
  const wasViewing = Boolean(viewerEl);
  if (route.name === 'viewer') {
    if (!album.items.length) {
      location.replace(`#/a/${album.id}`);
      return;
    }
    if (pageKey !== `album:${album.id}`) {
      pageKey = `album:${album.id}`;
      renderStream(album);
    }
    openViewer(album, route.index);
    return;
  }
  closeViewer();
  if (pageKey !== `album:${album.id}`) {
    pageKey = `album:${album.id}`;
    renderStream(album);
  }
  if (wasViewing && returnFocusId) {
    document.querySelector(`[data-item-id="${returnFocusId}"]`)?.focus({ preventScroll: true });
    restorePageScroll();
    requestAnimationFrame(() => restorePageScroll());
  }
}

function lockPageScroll() {
  if (scrollLocked) return;
  const current = window.scrollY || document.documentElement.scrollTop || 0;
  if (current > 0) savedScroll = current;
  scrollLocked = true;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${savedScroll}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
}

function restorePageScroll() {
  const y = savedScroll;
  window.scrollTo(0, y);
  return y;
}

function unlockPageScroll() {
  if (!scrollLocked) return restorePageScroll();
  scrollLocked = false;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  return restorePageScroll();
}

function closeViewer() {
  if (!viewerEl) return;
  viewerEl.querySelectorAll('video').forEach((video) => video.pause());
  viewerEl.remove();
  viewerEl = null;
  viewerItems = [];
  document.body.classList.remove('is-viewing');
  const y = unlockPageScroll();
  const page = document.querySelector('.page');
  if (page) {
    page.removeAttribute('aria-hidden');
    page.inert = false;
  }
  if (theme) theme.content = '#f3eee7';
  requestAnimationFrame(() => window.scrollTo(0, y));
}

function warm(url) {
  if (!url || warmed.has(url)) return;
  warmed.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

function prefetch(index) {
  const count = viewerItems.length;
  for (const delta of [-1, 1]) {
    const item = viewerItems[wrap(index + delta, count)];
    if (item) warm(item.thumbUrl);
  }
}

function makeSpinner() {
  const spin = el('div', 'spinner');
  spin.setAttribute('aria-hidden', 'true');
  spin.append(el('span'));
  return spin;
}

function settleFrame(frame) {
  if (!frame || frame.classList.contains('is-failed') || frame.classList.contains('is-ready')) return;
  frame.classList.add('is-ready');
  const spin = frame.querySelector('.spinner');
  if (spin) spin.hidden = true;
}

function failFrame(frame) {
  frame.classList.add('is-failed');
  const spin = frame.querySelector('.spinner');
  if (spin) spin.hidden = true;
  frame.querySelector('.original')?.remove();
}

function previewImage(item, { eager = false } = {}) {
  if (!item.thumbUrl) return null;
  const preview = document.createElement('img');
  preview.className = 'preview';
  preview.alt = '';
  preview.hidden = true;
  preview.draggable = false;
  preview.decoding = 'async';
  preview.setAttribute('aria-hidden', 'true');
  preview.fetchPriority = eager ? 'high' : 'low';
  const show = () => { preview.hidden = false; };
  preview.addEventListener('load', show, { once: true });
  preview.addEventListener('error', () => {
    preview.remove();
    preview.parentElement?.classList.add('no-preview');
  });
  preview.src = item.thumbUrl;
  if (preview.complete && preview.naturalWidth > 0) show();
  return preview;
}

function watchVideo(video, frame) {
  const reveal = () => {
    if (frame.classList.contains('is-ready') || frame.classList.contains('is-failed')) return;
    settleFrame(frame);
  };
  video.addEventListener('loadeddata', reveal);
  video.addEventListener('canplay', reveal);
  video.addEventListener('error', () => {
    if (frame.classList.contains('is-ready')) return;
    failFrame(frame);
  }, { once: true });
  return reveal;
}

function clearSlide(slide) {
  slide.replaceChildren();
  delete slide.dataset.itemId;
}

function startStill(img, frame, item) {
  if (!img || !frame || img.dataset.armed === '1') return;
  img.dataset.armed = '1';
  img.fetchPriority = 'high';
  const reveal = () => {
    if (!frame.isConnected || frame.classList.contains('is-ready') || frame.classList.contains('is-failed')) return;
    if (!img.isConnected) {
      const spin = frame.querySelector('.spinner');
      if (spin) frame.insertBefore(img, spin);
      else frame.append(img);
    }
    settleFrame(frame);
  };
  const ready = () => {
    if (typeof img.decode === 'function') img.decode().then(reveal, reveal);
    else reveal();
  };
  img.src = stillSrc(item);
  if (img.complete) {
    if (img.naturalWidth > 0) ready();
    else failFrame(frame);
    return;
  }
  img.addEventListener('load', ready, { once: true });
  img.addEventListener('error', () => {
    if (!frame.isConnected || frame.classList.contains('is-ready')) return;
    failFrame(frame);
  }, { once: true });
}

function tuneCurrent(slide) {
  if (!slide) return;
  const frame = slide.querySelector('.frame');
  const item = viewerItems.find((entry) => entry.id === slide.dataset.itemId);
  if (frame && item?.kind === 'photo') startStill(frame._still, frame, item);
  const preview = slide.querySelector('.preview');
  if (preview) preview.fetchPriority = 'high';
  const original = slide.querySelector('img.original');
  if (original) original.fetchPriority = 'high';
  const video = slide.querySelector('video');
  if (video && video.preload !== 'auto') {
    video.preload = 'auto';
    if (video.readyState >= 2) video.dispatchEvent(new Event('loadeddata'));
  }
}

function fillSlide(slide, item, { eager = false } = {}) {
  slide.replaceChildren();
  if (!item) {
    delete slide.dataset.itemId;
    return;
  }
  slide.dataset.itemId = item.id;
  const frame = el('div', 'frame');
  const preview = previewImage(item, { eager });
  const spin = makeSpinner();
  if (preview) frame.append(preview);

  if (item.kind === 'video') {
    const video = document.createElement('video');
    video.className = 'original';
    video.poster = item.thumbUrl || '';
    video.controls = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = eager ? 'auto' : 'metadata';
    video.controlsList = 'nodownload';
    frame.append(video, spin);
    slide.append(frame);
    const reveal = watchVideo(video, frame);
    video.src = item.fileUrl;
    if (video.readyState >= 2) reveal();
    return;
  }

  const img = document.createElement('img');
  img.className = 'original';
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  frame._still = img;
  frame.append(spin);
  const gesture = el('div', 'gesture full');
  slide.append(frame, gesture);
  if (eager) startStill(img, frame, item);
}

function likedSet() {
  try {
    const raw = JSON.parse(localStorage.getItem('family-media-liked') || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function rememberLiked(set) {
  try { localStorage.setItem('family-media-liked', JSON.stringify([...set])); } catch { /* private mode */ }
}

function whenOf(item) {
  const parsed = Date.parse(item?.takenAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickCover(items) {
  if (!items?.length) return null;
  const engaged = items.some((item) => (item.likes || 0) > 0 || (item.comments?.length || 0) > 0);
  if (!engaged) {
    let oldest = items[0];
    for (const item of items) {
      if (whenOf(item) < whenOf(oldest)) oldest = item;
    }
    return oldest.id;
  }
  let best = items[0];
  let bestLikes = -1;
  let bestComments = -1;
  for (const item of items) {
    const likes = item.likes || 0;
    const comments = item.comments?.length || 0;
    const newer = whenOf(item) > whenOf(best);
    if (
      likes > bestLikes
      || (likes === bestLikes && comments > bestComments)
      || (likes === bestLikes && comments === bestComments && newer)
    ) {
      best = item;
      bestLikes = likes;
      bestComments = comments;
    }
  }
  return best.id;
}

function retouchCover(itemId) {
  for (const album of details.values()) {
    if (!album.items?.some((item) => item.id === itemId)) continue;
    const cover = album.items.find((item) => item.id === pickCover(album.items));
    const summary = home.albums.find((entry) => entry.id === album.id);
    if (!summary || !cover) continue;
    summary.cover = { id: cover.id, kind: cover.kind, thumbUrl: cover.thumbUrl };
    const card = document.querySelector(`[data-album-id="${album.id}"]`);
    const img = card?.querySelector('img');
    if (img) img.src = cover.thumbUrl;
  }
}

function renderCommentList(item) {
  const list = viewerEl.querySelector('.comment-list');
  list.replaceChildren();
  const comments = item.comments || [];
  if (comments.length === 0) {
    list.append(el('p', 'comment-empty', '还没有留言。写一句吧。'));
    return;
  }
  for (const comment of comments) {
    list.append(el('p', 'comment', comment.text));
  }
  list.scrollTop = list.scrollHeight;
}

function syncActions() {
  const item = viewerItems[viewerIndex];
  if (!item || !viewerEl) return;
  const likes = item.likes || 0;
  const on = likes > 0 && likedSet().has(item.id);
  const like = viewerEl.querySelector('.like');
  like.classList.toggle('is-on', on);
  like.setAttribute('aria-pressed', on ? 'true' : 'false');
  like.querySelector('.count').textContent = String(likes);
  const comments = item.comments || [];
  viewerEl.querySelector('.open-comments .count').textContent = comments.length ? String(comments.length) : '';
  renderCommentList(item);
}

async function toggleLike() {
  const item = viewerItems[viewerIndex];
  if (!item) return;
  const set = likedSet();
  const on = !set.has(item.id);
  const button = viewerEl.querySelector('.like');
  button.disabled = true;
  try {
    const res = await fetch('/api/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, on }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return;
    item.likes = body.likes || 0;
    if (on && item.likes > 0) set.add(item.id);
    else set.delete(item.id);
    rememberLiked(set);
    retouchCover(item.id);
    syncActions();
  } finally {
    button.disabled = false;
  }
}

function insertEmoji(emoji) {
  const input = viewerEl.querySelector('.comment-input');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const next = `${input.value.slice(0, start)}${emoji}${input.value.slice(end)}`.slice(0, 200);
  input.value = next;
  const pos = Math.min(start + emoji.length, next.length);
  input.focus();
  try { input.setSelectionRange(pos, pos); } catch { /* some mobile browsers */ }
}

function setEmojiOpen(open) {
  const grid = viewerEl.querySelector('.emoji-grid');
  const toggle = viewerEl.querySelector('.emoji-toggle');
  if (!grid || !toggle) return;
  grid.hidden = !open;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function sendComment() {
  const item = viewerItems[viewerIndex];
  const input = viewerEl.querySelector('.comment-input');
  const text = input.value.trim();
  if (!item || !text) return;
  const button = viewerEl.querySelector('.comment-send');
  button.disabled = true;
  try {
    const res = await fetch('/api/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return;
    item.comments = body.comments || [];
    input.value = '';
    retouchCover(item.id);
    syncActions();
  } finally {
    button.disabled = false;
    input.focus();
  }
}

function placeSlides(track, indexes, count, dir) {
  let slides = [...track.children];
  const current = viewerItems[indexes[1]];
  let reused = false;
  if (dir && count > 1 && slides.length === 3 && current) {
    if (dir > 0 && slides[2].dataset.itemId === current.id) {
      track.append(slides[0]);
      slides = [...track.children];
      fillSlide(slides[2], viewerItems[indexes[2]]);
      reused = true;
    } else if (dir < 0 && slides[0].dataset.itemId === current.id) {
      track.prepend(slides[2]);
      slides = [...track.children];
      fillSlide(slides[0], viewerItems[indexes[0]]);
      reused = true;
    }
  }
  if (!reused) {
    slides.forEach((slide, slot) => {
      if (count <= 1 && slot !== 1) {
        clearSlide(slide);
        return;
      }
      fillSlide(slide, viewerItems[indexes[slot]], { eager: slot === 1 });
    });
  }
  tuneCurrent(track.children[1]);
}

function paintViewer(index, { dir = 0 } = {}) {
  const count = viewerItems.length;
  const previous = viewerEl.dataset.index;
  viewerIndex = wrap(index, count);
  if (previous !== String(viewerIndex)) {
    const sheet = viewerEl.querySelector('.comment-sheet');
    if (sheet) sheet.hidden = true;
    setEmojiOpen(false);
  }
  const indexes = count <= 1
    ? [0, 0, 0]
    : [wrap(viewerIndex - 1, count), viewerIndex, wrap(viewerIndex + 1, count)];
  const track = viewerEl.querySelector('.track');
  track.style.transition = 'none';
  placeSlides(track, indexes, count, dir);
  track.style.transform = 'translate3d(-33.333333%, 0, 0)';
  const item = viewerItems[viewerIndex];
  viewerEl.classList.toggle('is-video', item?.kind === 'video');
  viewerEl.querySelector('.viewer-count').textContent = count ? `${viewerIndex + 1} / ${count}` : '';
  viewerEl.querySelector('.viewer-date').textContent = formatWhen(item);
  fillPlace(item);
  syncActions();
  viewerEl.dataset.index = String(viewerIndex);
  viewerEl.dataset.count = String(count);
  const hash = `#/a/${viewerAlbumId}/p/${viewerIndex}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  prefetch(viewerIndex);
}

function shiftViewer(dir) {
  const count = viewerItems.length;
  if (count < 2 || viewerBusy) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  dismissHint();
  viewerEl.querySelectorAll('video').forEach((video) => video.pause());
  if (reduce) {
    paintViewer(viewerIndex + dir, { dir });
    return;
  }
  viewerBusy = true;
  const track = viewerEl.querySelector('.track');
  const target = dir > 0 ? '-66.666666%' : '0%';
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    track.removeEventListener('transitionend', onEnd);
    paintViewer(viewerIndex + dir, { dir });
    viewerBusy = false;
  };
  const onEnd = (event) => {
    if (event.propertyName === 'transform') finish();
  };
  track.addEventListener('transitionend', onEnd);
  track.style.transition = 'transform 280ms cubic-bezier(.22,.8,.2,1)';
  track.style.transform = `translate3d(${target}, 0, 0)`;
  window.setTimeout(finish, 420);
}

async function fillPlace(item) {
  const token = ++placeToken;
  if (!item?.located || readablePlace(item.place)) return;
  try {
    const res = await fetch(`/api/place/${item.id}`, { headers: { Accept: 'application/json' } });
    if (!res.ok || token !== placeToken) return;
    const body = await res.json().catch(() => ({}));
    const place = readablePlace(body.place);
    if (!place || token !== placeToken || !viewerEl) return;
    item.place = place;
    if (viewerItems[viewerIndex]?.id === item.id) {
      viewerEl.querySelector('.viewer-date').textContent = formatWhen(item);
    }
  } catch {
    /* date stays, location stays off */
  }
}

function dismissHint() {
  const hint = viewerEl?.querySelector('.hint');
  if (hint) hint.remove();
  try { sessionStorage.setItem('family-media-hint', '1'); } catch { /* private mode */ }
}

function bindViewerGestures(stage) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let axis = null;
  let fromVideo = false;
  let armed = false;

  const arm = (event) => {
    if (armed) return;
    armed = true;
    if (fromVideo) {
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  };

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || viewerItems.length < 2 || viewerBusy) return;
    if (event.target.closest('button, a, input, .viewer-actions, .viewer-bar')) return;
    const video = event.target.closest('video');
    if (video) {
      const rect = video.getBoundingClientRect();
      if (rect.bottom - event.clientY < 120) return;
    }
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
    axis = null;
    fromVideo = Boolean(video);
    armed = !fromVideo;
    if (!fromVideo) {
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  }, true);

  stage.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!axis) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'x') arm(event);
      else if (fromVideo) {
        pointerId = null;
        return;
      }
    }
    if (!armed || axis !== 'x') return;
    const width = stage.clientWidth || 1;
    const percent = -33.333333 + (dx / width) * 33.333333;
    const track = viewerEl.querySelector('.track');
    track.style.transition = 'none';
    track.style.transform = `translate3d(${percent}%, 0, 0)`;
  });

  const end = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    const width = stage.clientWidth || 1;
    const threshold = Math.max(48, width * 0.18);
    if (axis === 'x' && dx <= -threshold) shiftViewer(1);
    else if (axis === 'x' && dx >= threshold) shiftViewer(-1);
    else if (axis === 'x') {
      const track = viewerEl.querySelector('.track');
      track.style.transition = 'transform 220ms ease';
      track.style.transform = 'translate3d(-33.333333%, 0, 0)';
    }
    axis = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function openViewer(album, index) {
  viewerItems = album.items;
  viewerAlbumId = album.id;
  if (!viewerEl) {
    lockPageScroll();
    viewerEl = el('div', 'viewer');
    viewerEl.role = 'dialog';
    viewerEl.ariaModal = 'true';
    viewerEl.setAttribute('aria-label', '正在看');
    const bar = el('div', 'viewer-bar');
    const close = el('button', 'close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.innerHTML = CLOSE;
    close.addEventListener('click', () => leaveViewer());
    const meta = el('div', 'viewer-meta');
    meta.append(el('p', 'viewer-count'), el('p', 'viewer-date'));
    bar.append(close, meta, el('span', 'viewer-spacer'));
    const stage = el('div', 'stage');
    const track = el('div', 'track');
    track.append(el('div', 'slide'), el('div', 'slide'), el('div', 'slide'));
    stage.append(track);
    const prev = el('button', 'side prev');
    prev.type = 'button';
    prev.setAttribute('aria-label', '上一张');
    prev.innerHTML = CHEVRON;
    const next = el('button', 'side next');
    next.type = 'button';
    next.setAttribute('aria-label', '下一张');
    next.innerHTML = CHEVRON;
    prev.addEventListener('click', () => shiftViewer(-1));
    next.addEventListener('click', () => shiftViewer(1));
    const actions = el('div', 'viewer-actions');
    const like = el('button', 'like');
    like.type = 'button';
    like.setAttribute('aria-pressed', 'false');
    like.innerHTML = `${HEART}<span>喜欢</span><span class="count">0</span>`;
    like.addEventListener('click', () => toggleLike());
    const openComments = el('button', 'open-comments');
    openComments.type = 'button';
    openComments.innerHTML = '<span>留言</span><span class="count"></span>';
    openComments.addEventListener('click', () => {
      viewerEl.querySelector('.comment-sheet').hidden = false;
    });
    actions.append(like, openComments);
    const sheet = el('section', 'comment-sheet');
    sheet.hidden = true;
    sheet.setAttribute('aria-label', '留言');
    const sheetBar = el('div', 'sheet-bar');
    const done = el('button', 'text-btn', '完成');
    done.type = 'button';
    done.addEventListener('click', () => {
      sheet.hidden = true;
      setEmojiOpen(false);
    });
    sheetBar.append(el('h2', null, '留言'), done);
    const grid = el('div', 'emoji-grid');
    grid.hidden = true;
    grid.setAttribute('aria-label', '表情');
    for (const emoji of EMOJI) {
      const pick = el('button', 'emoji', emoji);
      pick.type = 'button';
      pick.setAttribute('aria-label', emoji);
      pick.addEventListener('click', () => insertEmoji(emoji));
      grid.append(pick);
    }
    const form = document.createElement('form');
    form.className = 'comment-form';
    const input = document.createElement('input');
    input.className = 'comment-input';
    input.maxLength = 200;
    input.enterKeyHint = 'send';
    input.autocomplete = 'off';
    input.placeholder = '写一句';
    input.setAttribute('aria-label', '写一句');
    const emojiToggle = el('button', 'emoji-toggle');
    emojiToggle.type = 'button';
    emojiToggle.setAttribute('aria-expanded', 'false');
    emojiToggle.setAttribute('aria-label', '表情');
    emojiToggle.innerHTML = '<span aria-hidden="true">😊</span><span>表情</span>';
    emojiToggle.addEventListener('click', () => {
      const open = grid.hidden;
      setEmojiOpen(open);
      if (open) input.blur();
    });
    const send = el('button', 'primary comment-send', '发送');
    send.type = 'submit';
    form.append(input, emojiToggle, send);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      sendComment();
    });
    sheet.append(sheetBar, el('div', 'comment-list'), grid, form);
    viewerEl.append(stage, bar, prev, next, actions, sheet);
    let seen = false;
    try { seen = sessionStorage.getItem('family-media-hint') === '1'; } catch { seen = false; }
    if (!seen && album.items.length > 1) {
      viewerEl.append(el('p', 'hint', '左右滑动'));
      window.setTimeout(dismissHint, 3600);
    }
    bindViewerGestures(stage);
    document.body.append(viewerEl);
  }
  document.body.classList.add('is-viewing');
  const page = document.querySelector('.page');
  if (page) {
    page.setAttribute('aria-hidden', 'true');
    page.inert = true;
  }
  if (theme) theme.content = '#0c0b0a';
  paintViewer(index);
  viewerEl.querySelector('.close').focus({ preventScroll: true });
}

function leaveViewer() {
  if (pushedViewer) {
    pushedViewer = false;
    history.back();
    return;
  }
  location.hash = `#/a/${viewerAlbumId}`;
}

async function reload() {
  const button = document.querySelector('.text-btn, .primary');
  if (button) button.disabled = true;
  home = { title: '荞荞的照片', total: 0, albums: [] };
  details = new Map();
  pageKey = '';
  await boot();
}

async function boot() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  showLoading();
  home = { title: '荞荞的照片', total: 0, albums: [] };
  details = new Map();
  pageKey = '';
  try {
    const result = await fetchBatch();
    if (result === 'auth') {
      showGate();
      return;
    }
    await openRoute(parseHash());
  } catch (err) {
    showError(err.message || '没有连上。请确认电脑开着，手机也连着家里的 Wi-Fi。');
  }
}

window.addEventListener('hashchange', () => {
  if (parseHash().name !== 'viewer') pushedViewer = false;
  openRoute(parseHash());
});

window.addEventListener('keydown', (event) => {
  if (!viewerEl) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    leaveViewer();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    shiftViewer(1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    shiftViewer(-1);
  }
});

boot();
