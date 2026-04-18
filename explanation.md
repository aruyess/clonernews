# ClonerNews — объяснение проекта

> Объяснение проекта шаг за шагом — от точки запуска до деталей реализации.

Проект — UI для Hacker News API. Три файла:
- `index.html` — разметка
- `style.css` — стили
- `clonernews.js` — вся логика

Скрипт подключён через `<script src="clonernews.js" defer>` — выполнится после парсинга DOM.

## Содержание

1. [Точка запуска](#1-точка-запуска)
2. [Загрузка ленты — `loadFeed`](#2-загрузка-ленты--loadfeed)
3. [Пагинация — `loadMore`](#3-пагинация--loadmore)
4. [Параллельная загрузка и кэш](#4-параллельная-загрузка-и-кэш)
5. [Рендер поста — `renderPost`](#5-рендер-поста--renderpost)
6. [Комментарии и рекурсия](#6-комментарии-и-рекурсия)
7. [Бесконечный скролл](#7-бесконечный-скролл)
8. [Live-обновления](#8-live-обновления--polllive)
9. [UI-обработчики](#9-ui-обработчики)
10. [Итоговая схема потока](#10-итоговая-схема-потока)
11. [Ключевые идеи](#11-ключевые-идеи)

---

## 1. Точка запуска

Последние строки файла — точка входа:

```js
window.addEventListener('scroll', onScroll, { passive: true });
setInterval(pollLive, LIVE_MS);
loadFeed('newstories');
```

При загрузке страницы:

- **Подписка на скролл** — для ленивой подгрузки постов
- **Таймер live-обновлений** — проверка новых данных каждые 5 секунд
- **Первая загрузка** ленты "New"

---

## 2. Загрузка ленты — `loadFeed`

```js
async function loadFeed(feed) {
  const gen = ++state.gen;
  Object.assign(state, { feed, cursor: 0, loading: false, ids: [] });
  feedEl.innerHTML = '';
  try {
    const ids = await fetchJson(`${feed}.json`);
    if (gen !== state.gen) return;
    state.ids = ids || [];
    await loadMore();
  } catch (err) { ... }
}
```

- `++state.gen` — **токен поколения**. Защита от race condition: если юзер переключит вкладку, токен изменится и старая операция не отрендерит посты.
- `Object.assign` — сбрасываем состояние ленты одной строкой.
- `fetchJson('newstories.json')` — API возвращает массив id (до 500 штук), но только id, не сами посты.
- `loadMore()` — подгружаем первую страницу.

---

## 3. Пагинация — `loadMore`

```js
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
```

- **Guard** — не запускаться параллельно, не выходить за массив.
- `state.cursor += PAGE_SIZE` двигается **до** `await` — параллельный вызов не возьмёт те же id.
- `fetchAll` загружает 20 items параллельно.
- **Сортировка** newest→oldest и рендер.
- `finally` — `loading = false` даже при ошибке.

---

## 4. Параллельная загрузка и кэш

```js
async function fetchAll(ids) {
  const results = await Promise.allSettled(ids.map(fetchItem));
  return results.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
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
```

- `Promise.allSettled` — ждёт все запросы, даже упавшие (`Promise.all` сломал бы весь батч из-за одной ошибки).
- `flatMap` — одним проходом фильтрует успешные и извлекает значение.
- **Кэш на `Map`** — один id не грузится дважды.
- При ошибке промис удаляется из кэша → следующий вызов попробует заново.

---

## 5. Рендер поста — `renderPost`

```js
function renderPost(item) {
  const url = safeUrl(item.url);
  const title = item.title || '(no title)';
  const titleHtml = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : title;

  const el = document.createElement('article');
  el.innerHTML = `<h2>${titleHtml}</h2>...`;

  if (item.parts) renderPolls(...);
  el.querySelector('.show-comments')?.addEventListener(...);
  feedEl.appendChild(el);
}
```

- `safeUrl` — валидирует протокол, блокирует `javascript:` URL.
- `escapeHtml` — экранирует `by`, `type`, URL → защита от XSS.
- Если `item.parts` (это poll) → `renderPolls`.
- Если `item.kids` — привязываем клик для раскрытия комментариев.

> **Типы постов:** все они — просто "items" в HN API. Различаются полями: `url` у story, `text` у job/ask, `parts` у poll, `kids` у чего угодно с комментариями. Код обрабатывает каждое поле опционально.

---

## 6. Комментарии и рекурсия

```js
async function toggleComments(postEl, kidIds) {
  const box = postEl.querySelector('.comments');
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  if (opened.has(box)) return;
  opened.add(box);
  ...
  await renderKids(box, kidIds);
}
```

- **Toggle**: открыто — скрыть, скрыто — показать.
- `WeakSet` `opened` запоминает загруженные блоки — повторно не грузим.

```js
async function renderKids(container, ids) {
  const kids = (await fetchAll(ids))
    .filter(c => !c.deleted && !c.dead)
    .sort(byNewest);

  for (const c of kids) {
    // создать div комментария
    if (c.kids?.length) {
      renderKids(nest, c.kids).catch(() => {});  // ← рекурсия
    }
  }
}
```

**Рекурсия** для вложенных комментариев любой глубины. База рекурсии — пустой `c.kids`.

---

## 7. Бесконечный скролл

```js
const onScroll = debounce(() => {
  if (sentinelEl.getBoundingClientRect().top < window.innerHeight + SCROLL_BUFFER) loadMore();
}, SCROLL_MS);
```

- **debounce 150ms** — не реагирует на каждый пиксель скролла.
- `#sentinel` — элемент-маркер внизу страницы. Когда он в пределах 200px от низа viewport — грузим следующую страницу.
- `{ passive: true }` — браузер знает, что обработчик не вызовет `preventDefault`, может скроллить плавнее.

---

## 8. Live-обновления — `pollLive`

```js
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
```

- Каждые 5 сек запрос `/maxitem` — это **id** последнего элемента на HN.
- **Первый тик** — запоминаем baseline `seenMax`.
- **Далее** — если `max` вырос, показываем баннер с количеством новых элементов.
- `catch` без действия — сеть мигнула, через 5 сек попробуем снова.

---

## 9. UI-обработчики

```js
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
```

- **Клик по баннеру** → перезагрузка текущей ленты с нуля.
- **Event delegation** на `<nav>` — один listener вместо пяти. `closest('button[data-feed]')` находит кнопку независимо от того, куда кликнули внутри неё.

---

## 10. Итоговая схема потока

```
defer script loaded → DOM ready
        │
        ├── addEventListener('scroll') → onScroll (debounce 150ms)
        │         └── rect близко к низу? → loadMore()
        │
        ├── setInterval(pollLive, 5000)
        │         └── fetchJson('maxitem.json')
        │               └── max > seenMax? → показать #live-banner
        │
        └── loadFeed('newstories')
              │
              ├── fetchJson('newstories.json') → [id, id, id, ...]
              │
              └── loadMore()
                    │
                    └── fetchAll(slice of 20 ids)
                          │    └── cache + Promise.allSettled
                          │
                          └── sort(byNewest) → forEach renderPost
                                │
                                ├── safeUrl + escapeHtml → <article>
                                ├── item.parts → renderPolls
                                └── click "Show comments" → toggleComments
                                                                 │
                                                                 └── renderKids(kids)
                                                                       └── (рекурсия на c.kids)
```

---

## 11. Ключевые идеи

| Идея | Как реализовано |
|---|---|
| **Ленивая загрузка** | Только 20 постов за раз, курсор + скролл-триггер |
| **Кэш запросов** | `Map` по id — один id не грузится дважды |
| **Защита от race condition** | `state.gen` — старые операции отбрасываются при смене ленты |
| **Устойчивость к ошибкам** | `Promise.allSettled` + `try/catch` везде |
| **Безопасность** | `escapeHtml` + `safeUrl` → защита от XSS |
| **Минимум запросов** | debounce на скролле + кэш + пагинация |
| **Live-обновления** | 1 запрос в 5 секунд, баннер при новых данных |
| **Вложенные комментарии** | Рекурсия `renderKids` с базой на `!c.kids` |
