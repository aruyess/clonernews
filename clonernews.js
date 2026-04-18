const API = 'https://hacker-news.firebaseio.com/v0';
const PAGE_SIZE = 20;
const LIVE_MS = 5000;
const SCROLL_MS = 150;
const SCROLL_BUFFER = 200;
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:'];

const $ = (sel) => document.querySelector(sel);
const feedEl = $('#feed');
const sentinelEl = $('#sentinel');
const bannerEl = $('#live-banner');
const navEl = $('nav');

const state = { feed: 'newstories', ids: [], cursor: 0, loading: false, seenMax: 0, gen: 0 };
const opened = new WeakSet();
const cache = new Map();

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const safeUrl = (url) => {
  try { return SAFE_PROTOCOLS.includes(new URL(url).protocol) ? url : ''; }
  catch { return ''; }
};

const formatTime = (t) => t ? new Date(t * 1000).toLocaleString() : '';

const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

async function fetchJson(path) {
  const r = await fetch(`${API}/${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function fetchItem(id) {
  if (!cache.has(id)) {
    cache.set(id, fetchJson(`item/${id}.json`).catch(err => {
      cache.delete(id);
      throw err;
    }));
  }
  return cache.get(id);
}

async function fetchAll(ids) {
  const results = await Promise.allSettled(ids.map(fetchItem));
  return results.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
}

const byNewest = (a, b) => (b.time || 0) - (a.time || 0);

async function loadFeed(feed) {
  const gen = ++state.gen;
  Object.assign(state, { feed, cursor: 0, loading: false, ids: [] });
  feedEl.innerHTML = '';
  try {
    const ids = await fetchJson(`${feed}.json`);
    if (gen !== state.gen) return;
    state.ids = ids || [];
    await loadMore();
  } catch (err) {
    if (gen === state.gen) feedEl.innerHTML = `<p class="error">Failed: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadMore() {
  if (state.loading || state.cursor >= state.ids.length) return;
  state.loading = true;
  const gen = state.gen;
  const slice = state.ids.slice(state.cursor, state.cursor += PAGE_SIZE);
  try {
    const items = await fetchAll(slice);
    if (gen === state.gen) items.sort(byNewest).forEach(renderPost);
  } finally {
    state.loading = false;
  }
}

function renderPost(item) {
  const url = safeUrl(item.url);
  const title = item.title || '(no title)';
  const titleHtml = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : title;

  const el = document.createElement('article');
  el.className = 'post';
  el.innerHTML = `
    <h2>${titleHtml}</h2>
    <div class="meta">${escapeHtml(item.type)} · by ${escapeHtml(item.by || '—')} · ${formatTime(item.time)} · ${item.score ?? 0} pts</div>
    ${item.text ? `<div class="body">${item.text}</div>` : ''}
    ${item.parts ? `<div class="parts"></div>` : ''}
    ${item.kids ? `<button class="show-comments">Show ${item.descendants ?? ''} comments</button><div class="comments" hidden></div>` : ''}
  `;

  if (item.parts) renderPolls(el.querySelector('.parts'), item.parts);
  el.querySelector('.show-comments')?.addEventListener('click', () => toggleComments(el, item.kids));
  feedEl.appendChild(el);
}

async function renderPolls(container, ids) {
  (await fetchAll(ids)).forEach(o => {
    const d = document.createElement('div');
    d.className = 'poll-opt';
    d.innerHTML = `${o.text || ''} — <strong>${o.score ?? 0}</strong>`;
    container.appendChild(d);
  });
}

async function toggleComments(postEl, kidIds) {
  const box = postEl.querySelector('.comments');
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  if (opened.has(box)) return;
  opened.add(box);

  box.innerHTML = '<div class="loading">Loading…</div>';
  try {
    box.innerHTML = '';
    await renderKids(box, kidIds);
  } catch (err) {
    opened.delete(box);
    box.innerHTML = `<div class="error">Failed: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderKids(container, ids) {
  const kids = (await fetchAll(ids))
    .filter(c => !c.deleted && !c.dead)
    .sort(byNewest);

  for (const c of kids) {
    const d = document.createElement('div');
    d.className = 'comment';
    d.innerHTML = `
      <div class="meta">${escapeHtml(c.by || '—')} · ${formatTime(c.time)}</div>
      <div>${c.text || ''}</div>
    `;
    container.appendChild(d);
    if (c.kids?.length) {
      const nest = document.createElement('div');
      nest.className = 'comments';
      d.appendChild(nest);
      renderKids(nest, c.kids).catch(() => {});
    }
  }
}

async function pollLive() {
  try {
    const max = await fetchJson('maxitem.json');
    if (!state.seenMax) { state.seenMax = max; return; }
    if (max > state.seenMax) {
      const n = max - state.seenMax;
      bannerEl.hidden = false;
      bannerEl.textContent = `${n} new item${n === 1 ? '' : 's'} — click to refresh`;
    }
  } catch { /* retry next tick */ }
}

const onScroll = debounce(() => {
  if (sentinelEl.getBoundingClientRect().top < window.innerHeight + SCROLL_BUFFER) loadMore();
}, SCROLL_MS);

bannerEl.addEventListener('click', () => {
  bannerEl.hidden = true;
  state.seenMax = 0;
  loadFeed(state.feed);
});

navEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-feed]');
  if (!btn) return;
  navEl.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === btn));
  loadFeed(btn.dataset.feed);
});

window.addEventListener('scroll', onScroll, { passive: true });
setInterval(pollLive, LIVE_MS);
loadFeed('newstories');
