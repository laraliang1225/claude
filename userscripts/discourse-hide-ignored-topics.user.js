// ==UserScript==
// @name         Discourse 屏蔽增强：隐藏被屏蔽用户的主题 + 用户卡片屏蔽按钮
// @namespace    https://github.com/laraliang1225/claude
// @version      2.1.0
// @description  在主题列表中隐藏你已屏蔽（忽略）用户发的主题；在用户卡片上加一个“屏蔽 / 取消屏蔽”按钮，个人资料被隐藏的用户也能一键屏蔽。
// @match        https://www.uscardforum.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // 屏蔽时长。Discourse 的“忽略”必须带过期时间，这里设成 100 年，相当于永久。
  const IGNORE_YEARS = 100;
  // 屏蔽名单多久从服务器重新拉一次（毫秒）。用卡片按钮屏蔽会立即更新，不受这个限制。
  const LIST_TTL = 10 * 60 * 1000;

  const ROW_SELECTOR = '.topic-list-item, .latest-topic-list-item, .featured-topic, .category-boxes-topic';
  const ROW_IS = `:is(${ROW_SELECTOR})`;

  const norm = (name) => String(name || '').trim().toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ---------- 状态 ----------

  let me = GM_getValue('me', '');
  let ignored = new Set(GM_getValue('ignored', []));
  let muted = new Set(GM_getValue('muted', []));
  let enabled = GM_getValue('enabled', true); // 总开关：是否隐藏被屏蔽用户的主题
  const opByTopic = new Map(); // 主题 ID → 楼主用户名（小写），只放内存

  function isBlocked(username) {
    const u = norm(username);
    return enabled && !!u && (ignored.has(u) || muted.has(u));
  }

  function saveLists() {
    GM_setValue('me', me);
    GM_setValue('ignored', [...ignored]);
    GM_setValue('muted', [...muted]);
    GM_setValue('listsAt', Date.now());
  }

  // ---------- 用 CSS 隐藏 ----------
  // 被屏蔽楼主的主题 ID 写成 CSS 规则：行一渲染出来就是隐藏的，不会先闪一下，也不用反复改 DOM。

  const style = document.createElement('style');
  let cssText = '';

  function updateStyle() {
    const ids = [];
    opByTopic.forEach((op, id) => { if (isBlocked(op)) ids.push(id); });
    const next = ids.length
      ? `${ids.map((id) => `${ROW_IS}[data-topic-id="${id}"]`).join(',\n')} { display: none !important; }`
      : '';
    if (next !== cssText) {
      cssText = next;
      style.textContent = next;
    }
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  }

  let styleQueued = false;
  function scheduleStyle() {
    if (styleQueued) return;
    styleQueued = true;
    Promise.resolve().then(() => { styleQueued = false; updateStyle(); });
  }

  // ---------- 从页面自己的数据里学楼主 ----------

  function collectTopics(data) {
    const topics = [];
    const add = (items) => { if (Array.isArray(items)) topics.push(...items); };
    const addCategories = (cats) => {
      if (!Array.isArray(cats)) return;
      cats.forEach((c) => { if (c) { add(c.topics); addCategories(c.subcategory_list); } });
    };
    add(data.topic_list && data.topic_list.topics);
    add(data.category_list && data.category_list.topics);
    addCategories(data.category_list && data.category_list.categories);
    add(data.featured_topics);
    return topics;
  }

  function learnOps(data) {
    if (!data || typeof data !== 'object') return;
    const topics = collectTopics(data);
    if (!topics.length) return;
    const users = new Map();
    (data.users || (data.topic_list && data.topic_list.users) || [])
      .forEach((u) => users.set(u.id, u.username));
    let changed = false;
    topics.forEach((t) => {
      const posters = t.posters || [];
      const op = posters.find((p) => /原始|Original/i.test(p.description || '')) || posters[0];
      const name = (op && (users.get(op.user_id) || op.username)) || (t.creator && t.creator.username);
      if (t.id != null && name && opByTopic.get(String(t.id)) !== norm(name)) {
        opByTopic.set(String(t.id), norm(name));
        changed = true;
      }
    });
    if (changed) scheduleStyle();
  }

  const LIST_KEYS = /"(topic_list|category_list|featured_topics)"/;
  function learnFromText(text) {
    if (typeof text !== 'string' || !LIST_KEYS.test(text)) return;
    try { learnOps(JSON.parse(text)); } catch (e) { /* 不是 JSON */ }
  }

  // 首屏：Discourse 把首屏数据和当前用户嵌在 #data-preloaded 里。
  function readPreloaded(el) {
    let obj;
    try { obj = JSON.parse(el.dataset.preloaded); } catch (e) { return; }
    Object.entries(obj).forEach(([key, v]) => {
      let data;
      try { data = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return; }
      if (key === 'currentUser') {
        if (data && data.username) me = data.username;
      } else {
        learnOps(data);
      }
    });
  }

  // 站内跳转、加载更多：读论坛自己的 XHR / fetch 响应，不额外请求。
  const origSend = W.XMLHttpRequest.prototype.send;
  W.XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === 'json') learnOps(this.response);
        else if (this.responseType === '' || this.responseType === 'text') learnFromText(this.responseText);
      } catch (e) { /* 忽略 */ }
    });
    return origSend.apply(this, args);
  };

  const origFetch = W.fetch;
  W.fetch = function (...args) {
    const promise = origFetch.apply(this, args);
    promise.then((res) => {
      if ((res.headers.get('content-type') || '').includes('json')) {
        res.clone().text().then(learnFromText, () => {});
      }
    }, () => {});
    return promise;
  };

  // ---------- 兜底：页面数据里没有的主题，逐个查 1 楼 ----------
  // 正常情况下用不到。一次只发一个、间隔 1 秒，遇到 429 按服务器给的时间等待。

  const fallbackQueue = [];
  let fallbackRunning = false;

  async function runFallback() {
    if (fallbackRunning) return;
    fallbackRunning = true;
    await sleep(2000); // 先让上面的拦截把数据填进来
    while (fallbackQueue.length) {
      const id = fallbackQueue[0];
      if (opByTopic.has(id)) { fallbackQueue.shift(); continue; }
      let res;
      try {
        res = await origFetch.call(W, `/posts/by_number/${id}/1.json`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
      } catch (e) {
        await sleep(5000);
        continue;
      }
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After'), 10);
        await sleep((wait > 0 ? wait : 15) * 1000);
        continue;
      }
      const post = res.ok ? await res.json().catch(() => null) : null;
      opByTopic.set(id, norm(post && post.username)); // 查不到记成空，不再重复查
      scheduleStyle();
      fallbackQueue.shift();
      await sleep(1000);
    }
    fallbackRunning = false;
  }

  // ---------- 主题行：每行只处理一次 ----------

  const seenRows = new WeakSet();

  function rowTopicId(row) {
    if (row.dataset.topicId) return row.dataset.topicId;
    const link = row.querySelector('a.title, a.raw-topic-link, a[href*="/t/"]');
    const m = link && (link.getAttribute('href') || '').match(/\/t\/(?:[^/]+\/)?(\d+)/);
    return m ? m[1] : '';
  }

  function processRows() {
    document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
      if (seenRows.has(row)) return;
      seenRows.add(row);
      const id = rowTopicId(row);
      if (!id) return;
      // 没有 data-topic-id 的行（分类方块等）补上，好让 CSS 规则命中
      if (!row.dataset.topicId) row.dataset.topicId = id;
      if (opByTopic.has(id)) return;
      // 普通列表的 posters 列第一个头像就是楼主，直接读
      const first = row.querySelector('.posters [data-user-card]');
      if (first) {
        opByTopic.set(id, norm(first.dataset.userCard));
        scheduleStyle();
      } else if (!fallbackQueue.includes(id)) {
        fallbackQueue.push(id);
        runFallback();
      }
    });
  }

  // ---------- 屏蔽名单 ----------

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  async function api(path, options = {}) {
    const res = await origFetch.call(W, path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken(),
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && (data.errors || []).join('\n')) || `HTTP ${res.status}`);
    return data;
  }

  async function refreshLists(force = false) {
    if (!force && me && Date.now() - GM_getValue('listsAt', 0) < LIST_TTL) return;
    try {
      if (!me) {
        const session = await api('/session/current.json');
        me = (session && session.current_user && session.current_user.username) || '';
        if (!me) return; // 未登录
      }
      const data = await api(`/u/${encodeURIComponent(me)}.json`);
      const user = (data && data.user) || {};
      ignored = new Set((user.ignored_usernames || []).map(norm));
      muted = new Set((user.muted_usernames || []).map(norm));
      saveLists();
      scheduleStyle();
      updateCardButtons();
    } catch (e) {
      console.warn('[屏蔽增强] 拉取屏蔽名单失败：', e);
    }
  }

  async function setIgnore(username, ignore) {
    const body = new URLSearchParams({ notification_level: ignore ? 'ignore' : 'normal' });
    if (ignore) {
      const d = new Date();
      d.setFullYear(d.getFullYear() + IGNORE_YEARS);
      body.set('expiring_at', d.toISOString());
    }
    await api(`/u/${encodeURIComponent(username)}/notification_level.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    const u = norm(username);
    if (ignore) ignored.add(u);
    else { ignored.delete(u); muted.delete(u); } // 设为 normal 会同时解除禁言
    saveLists();
    scheduleStyle();
  }

  // ---------- 用户卡片屏蔽按钮 ----------

  function cardUsername(card) {
    const link = card.querySelector('a.user-profile-link, .names a[href*="/u/"], a[href*="/u/"]');
    const m = link && (link.getAttribute('href') || '').match(/\/u\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    for (const cls of card.classList) {
      const c = cls.match(/^user-card-(.+)$/);
      if (c) return c[1];
    }
    return '';
  }

  function renderButton(btn) {
    const blocked = ignored.has(norm(btn.dataset.username));
    btn.textContent = blocked ? '取消屏蔽' : '屏蔽';
    btn.className = `btn ${blocked ? 'btn-default' : 'btn-danger'} block-helper-btn`;
  }

  function updateCardButtons() {
    document.querySelectorAll('.block-helper-btn').forEach(renderButton);
  }

  async function onCardButtonClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const name = btn.dataset.username;
    const blocked = ignored.has(norm(name));
    const question = blocked
      ? `取消屏蔽 ${name}？`
      : `屏蔽 ${name}？\n屏蔽后他的帖子会被折叠，他发的主题也会从列表中隐藏。`;
    if (!confirm(question)) return;
    btn.disabled = true;
    try {
      await setIgnore(name, !blocked);
      updateCardButtons();
    } catch (e) {
      alert(`操作失败：${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  function processCards() {
    document.querySelectorAll('#user-card, .user-card').forEach((card) => {
      if (card.parentElement && card.parentElement.closest('#user-card, .user-card')) return;
      const username = cardUsername(card);
      if (!username || norm(username) === norm(me)) return;
      let btn = card.querySelector('.block-helper-btn');
      if (btn) {
        if (btn.dataset.username !== username) { btn.dataset.username = username; renderButton(btn); }
        return;
      }
      btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.username = username;
      btn.style.width = '100%';
      btn.addEventListener('click', onCardButtonClick);
      renderButton(btn);
      const controls = card.querySelector('.usercard-controls');
      if (controls) {
        const li = document.createElement(controls.tagName === 'UL' ? 'li' : 'div');
        li.appendChild(btn);
        controls.appendChild(li);
      } else {
        (card.querySelector('.card-content') || card).appendChild(btn);
      }
    });
  }

  // ---------- 启动 ----------

  let scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      processRows();
      processCards();
    });
  }

  // document-start 时就盯着，#data-preloaded 一出现马上读，赶在论坛渲染之前。
  const preloadWatcher = new MutationObserver(() => {
    const el = document.getElementById('data-preloaded');
    if (el) { preloadWatcher.disconnect(); readPreloaded(el); }
  });
  preloadWatcher.observe(document, { childList: true, subtree: true });

  function start() {
    const el = document.getElementById('data-preloaded');
    if (el) { preloadWatcher.disconnect(); readPreloaded(el); }
    updateStyle();
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    scheduleScan();
    refreshLists();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // ---------- 菜单 ----------
  // 开关切换后重新注册菜单，让菜单上的“开/关”文字马上更新。

  let menuIds = [];
  function registerMenus() {
    if (typeof GM_unregisterMenuCommand === 'function') menuIds.forEach((id) => GM_unregisterMenuCommand(id));
    menuIds = [
      GM_registerMenuCommand(`隐藏被屏蔽用户的主题：${enabled ? '开' : '关'}（点击切换）`, () => {
        enabled = !enabled;
        GM_setValue('enabled', enabled);
        updateStyle(); // 立即生效，不用刷新
        registerMenus();
      }),
      GM_registerMenuCommand('刷新屏蔽名单', async () => {
        await refreshLists(true);
        alert(`已屏蔽 ${ignored.size} 人，已禁言 ${muted.size} 人。`);
      }),
      GM_registerMenuCommand('诊断（排查用）', diagnose),
    ];
  }

  function diagnose() {
    const rows = [...document.querySelectorAll(ROW_SELECTOR)];
    const lines = [
      `当前用户：${me || '（没读到）'}`,
      `隐藏开关：${enabled ? '开' : '关'}`,
      `已屏蔽 ${ignored.size} 人，已禁言 ${muted.size} 人`,
      `已知楼主的主题：${opByTopic.size} 个；等待逐个查询：${fallbackQueue.length} 个`,
      `本页主题行：${rows.length} 个，其中被隐藏 ${rows.filter((r) => getComputedStyle(r).display === 'none').length} 个`,
      '前 8 行：',
      ...rows.slice(0, 8).map((r, i) => {
        const id = rowTopicId(r);
        const title = ((r.querySelector('a.title, a.raw-topic-link') || {}).textContent || '').trim().slice(0, 24);
        return `${i + 1}. [${id}] 楼主 ${opByTopic.get(id) || '?'} — ${title}`;
      }),
    ];
    console.log('[屏蔽增强] 诊断\n' + lines.join('\n'));
    alert(lines.join('\n'));
  }

  registerMenus();
})();
