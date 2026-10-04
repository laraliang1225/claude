// ==UserScript==
// @name         Discourse 屏蔽增强：隐藏被屏蔽用户的主题 + 用户卡片屏蔽按钮
// @namespace    https://github.com/laraliang1225/claude
// @version      1.4.0
// @description  在主题列表中隐藏你已屏蔽（忽略）用户发的主题；在用户卡片上加一个“屏蔽 / 取消屏蔽”按钮，个人资料被隐藏的用户也能一键屏蔽。
// @match        https://www.uscardforum.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 屏蔽时长。Discourse 的“忽略”必须带过期时间，这里设成 100 年，相当于永久。
  const IGNORE_YEARS = 100;
  // 缓存多久后重新从服务器拉取屏蔽列表（毫秒）。
  const CACHE_TTL = 10 * 60 * 1000;

  const settings = {
    get hideMuted() { return GM_getValue('hideMuted', true); },
    set hideMuted(v) { GM_setValue('hideMuted', v); },
  };

  let me = GM_getValue('me', null);
  let ignored = new Set(GM_getValue('ignored', []));
  let muted = new Set(GM_getValue('muted', []));

  const norm = (name) => (name || '').trim().toLowerCase();

  function isBlocked(username) {
    const u = norm(username);
    if (!u) return false;
    return ignored.has(u) || (settings.hideMuted && muted.has(u));
  }

  function saveCache() {
    GM_setValue('me', me);
    GM_setValue('ignored', [...ignored]);
    GM_setValue('muted', [...muted]);
    GM_setValue('fetchedAt', Date.now());
  }

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken(),
        ...(options.headers || {}),
      },
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const msg = (data && (data.errors || []).join('\n')) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function refreshLists(force = false) {
    const fetchedAt = GM_getValue('fetchedAt', 0);
    if (!force && me && Date.now() - fetchedAt < CACHE_TTL) return;
    try {
      const session = await api('/session/current.json');
      const username = session && session.current_user && session.current_user.username;
      if (!username) return; // 未登录
      me = username;
      const data = await api(`/u/${encodeURIComponent(username)}.json`);
      const user = (data && data.user) || {};
      ignored = new Set((user.ignored_usernames || []).map(norm));
      muted = new Set((user.muted_usernames || []).map(norm));
      saveCache();
      scan();
    } catch (e) {
      console.warn('[屏蔽增强] 拉取屏蔽列表失败：', e);
    }
  }

  // ---------- 隐藏主题 ----------

  // 主题 ID → 楼主用户名。楼主不会变，所以永久缓存，只保留最近 OP_CACHE_MAX 条。
  const OP_CACHE_MAX = 5000;
  const opCache = GM_getValue('opCache', {});
  const opQueue = [];
  const opQueued = new Set();
  let opActive = 0;

  function saveOpCache() {
    const keys = Object.keys(opCache);
    if (keys.length > OP_CACHE_MAX) {
      keys.slice(0, keys.length - OP_CACHE_MAX).forEach((k) => delete opCache[k]);
    }
    GM_setValue('opCache', opCache);
  }

  // 从主题列表 JSON 里批量记下楼主：posters 里标着“原始发帖人”的那个（一般是第一个）。
  function learnOps(data) {
    const list = data && data.topic_list;
    if (!list || !list.topics) return 0;
    const users = {};
    (data.users || list.users || []).forEach((u) => { users[u.id] = u.username; });
    let n = 0;
    list.topics.forEach((t) => {
      const posters = t.posters || [];
      const op = posters.find((p) => /原始|Original/i.test(p.description || '')) || posters[0];
      const name = op && users[op.user_id];
      if (name) { opCache[t.id] = name; n++; }
    });
    saveOpCache();
    return n;
  }

  // 楼主信息直接从页面自己已经加载的数据里读，不额外发请求：
  // 1. 第一次打开页面时，Discourse 把首屏数据嵌在 #data-preloaded 里；
  // 2. 站内跳转、加载更多时，拦截论坛自己的 XHR / fetch 响应。
  function readPreloaded(el) {
    try {
      const obj = JSON.parse(el.dataset.preloaded);
      Object.values(obj).forEach((v) => {
        try { learnOps(typeof v === 'string' ? JSON.parse(v) : v); } catch (e) { /* 不是 JSON */ }
      });
    } catch (e) {
      console.warn('[屏蔽增强] 读取预加载数据失败：', e);
    }
  }

  function learnFromText(text) {
    if (typeof text !== 'string' || text.indexOf('"topic_list"') === -1) return;
    try { if (learnOps(JSON.parse(text))) scheduleScan(); } catch (e) { /* 不是 JSON */ }
  }

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const origSend = W.XMLHttpRequest.prototype.send;
  W.XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === 'json') {
          if (this.response && learnOps(this.response)) scheduleScan();
        } else if (this.responseType === '' || this.responseType === 'text') {
          learnFromText(this.responseText);
        }
      } catch (e) { /* 忽略 */ }
    });
    return origSend.apply(this, args);
  };

  const origFetch = W.fetch;
  W.fetch = function (...args) {
    const promise = origFetch.apply(this, args);
    promise.then((res) => {
      if ((res.headers.get('content-type') || '').includes('json')) {
        res.clone().text().then(learnFromText).catch(() => {});
      }
    }).catch(() => {});
    return promise;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 兜底：页面数据里没找到楼主的主题，再逐个查 1 楼作者。
  // 先等 2 秒让上面的拦截把数据填进来；论坛有限流，所以一次只发一个、每个之间隔一会，
  // 遇到 429 就按服务器给的时间等待后重试。
  async function pumpOpQueue() {
    if (opActive) return;
    opActive = 1;
    await sleep(2000);
    while (opQueue.length) {
      const id = opQueue[0];
      if (id in opCache) { opQueue.shift(); opQueued.delete(id); continue; }
      try {
        const res = await fetch(`/posts/by_number/${id}/1.json`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (res.status === 429) {
          const wait = parseInt(res.headers.get('Retry-After'), 10);
          await sleep((wait > 0 ? wait : 15) * 1000);
          continue; // 重试同一个
        }
        const post = res.ok ? await res.json().catch(() => null) : null;
        // 404/403 等说明 1 楼被删或没权限，记成空，别反复请求
        opCache[id] = (post && post.username) || '';
        saveOpCache();
        scheduleScan();
      } catch (e) {
        console.warn(`[屏蔽增强] 获取主题 ${id} 的楼主失败：`, e);
        await sleep(5000);
        continue;
      }
      opQueue.shift();
      opQueued.delete(id);
      await sleep(800);
    }
    opActive = 0;
  }

  function topicId(row) {
    if (row.dataset.topicId) return row.dataset.topicId;
    const link = row.querySelector('a[href*="/t/"]');
    const m = link && (link.getAttribute('href') || '').match(/\/t\/(?:[^/]+\/)?(\d+)/);
    return m ? m[1] : null;
  }

  // 普通主题列表（最新/新/分类页）的 posters 列第一个头像就是楼主。
  // 首页“类别 + 最新”布局右侧那一栏只显示最后回复人的头像，楼主要按主题 ID 去查。
  function topicAuthor(row) {
    const el = row.querySelector('.posters [data-user-card], .posters a[href*="/u/"]');
    if (el) {
      if (el.dataset.userCard) return el.dataset.userCard;
      const m = (el.getAttribute('href') || '').match(/\/u\/([^/?#]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    const id = topicId(row);
    if (!id) return null;
    if (id in opCache) return opCache[id] || null;
    if (!opQueued.has(id)) {
      opQueued.add(id);
      opQueue.push(id);
      pumpOpQueue();
    }
    return null;
  }

  function hideTopics() {
    const rows = document.querySelectorAll(
      'tr.topic-list-item, .latest-topic-list-item, .topic-list-body > .topic-list-item'
    );
    rows.forEach((row) => {
      const author = topicAuthor(row);
      const hide = isBlocked(author);
      if (hide && !row.dataset.blockHidden) {
        row.dataset.blockHidden = '1';
        row.style.display = 'none';
      } else if (!hide && row.dataset.blockHidden) {
        delete row.dataset.blockHidden;
        row.style.display = '';
      }
    });
  }

  // ---------- 用户卡片屏蔽按钮 ----------

  function cardUsername(card) {
    const link = card.querySelector('a.user-profile-link, .names a[href*="/u/"], a[href*="/u/"]');
    if (link) {
      const m = (link.getAttribute('href') || '').match(/\/u\/([^/?#]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    for (const cls of card.classList) {
      const m = cls.match(/^user-card-(.+)$/);
      if (m) return m[1];
    }
    return null;
  }

  function farFuture() {
    const d = new Date();
    d.setFullYear(d.getFullYear() + IGNORE_YEARS);
    return d.toISOString();
  }

  async function setIgnore(username, ignore) {
    const body = new URLSearchParams();
    body.set('notification_level', ignore ? 'ignore' : 'normal');
    if (ignore) body.set('expiring_at', farFuture());
    await api(`/u/${encodeURIComponent(username)}/notification_level.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    const u = norm(username);
    if (ignore) {
      ignored.add(u);
    } else {
      ignored.delete(u);
      muted.delete(u); // 设为 normal 会同时解除禁言
    }
    saveCache();
    scan();
  }

  function renderButton(btn, username) {
    const blocked = ignored.has(norm(username));
    btn.textContent = blocked ? '取消屏蔽' : '屏蔽';
    btn.className = blocked ? 'btn btn-default block-helper-btn' : 'btn btn-danger block-helper-btn';
  }

  function addCardButton(card) {
    const username = cardUsername(card);
    if (!username || norm(username) === norm(me)) return;

    const existing = card.querySelector('.block-helper-btn');
    if (existing) {
      if (existing.dataset.username !== username) {
        existing.dataset.username = username;
        renderButton(existing, username);
      }
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.username = username;
    btn.style.width = '100%';
    renderButton(btn, username);

    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const name = btn.dataset.username;
      const blocked = ignored.has(norm(name));
      const question = blocked
        ? `取消屏蔽 ${name}？`
        : `屏蔽 ${name}？\n屏蔽后他的帖子会被折叠，他发的主题也会从列表中隐藏。`;
      if (!confirm(question)) return;
      btn.disabled = true;
      try {
        await setIgnore(name, !blocked);
        renderButton(btn, name);
      } catch (e) {
        alert(`操作失败：${e.message}`);
      } finally {
        btn.disabled = false;
      }
    });

    const controls = card.querySelector('.usercard-controls');
    if (controls) {
      const li = document.createElement(controls.tagName === 'UL' ? 'li' : 'div');
      li.appendChild(btn);
      controls.appendChild(li);
    } else {
      (card.querySelector('.card-content') || card).appendChild(btn);
    }
  }

  function addCardButtons() {
    document.querySelectorAll('#user-card, .user-card').forEach((card) => {
      // .user-card 可能嵌套在 #user-card 里，只处理最外层
      if (card.parentElement && card.parentElement.closest('#user-card, .user-card')) return;
      addCardButton(card);
    });
  }

  // ---------- 主循环 ----------

  function scan() {
    hideTopics();
    addCardButtons();
  }

  let pending = false;
  function scheduleScan() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      scan();
    });
  }
  // 脚本在 document-start 运行，好赶在论坛启动前装上拦截、读到预加载数据。
  const preloadWatcher = new MutationObserver(() => {
    const el = document.getElementById('data-preloaded');
    if (el) {
      preloadWatcher.disconnect();
      readPreloaded(el);
    }
  });
  preloadWatcher.observe(document, { childList: true, subtree: true });

  GM_registerMenuCommand('刷新屏蔽列表', async () => {
    await refreshLists(true);
    alert(`已屏蔽 ${ignored.size} 人，已禁言 ${muted.size} 人。`);
  });
  GM_registerMenuCommand(
    `同时隐藏“禁言”用户的主题：${settings.hideMuted ? '开' : '关'}（点击切换）`,
    () => {
      settings.hideMuted = !settings.hideMuted;
      alert(`已${settings.hideMuted ? '开启' : '关闭'}，刷新页面后菜单文字会更新。`);
      scan();
    }
  );

  // 换页时（Discourse 是单页应用）顺便检查缓存是否过期
  window.addEventListener('popstate', () => refreshLists());

  // 诊断：把脚本看到的东西列出来，方便排查为什么某个主题没被隐藏
  GM_registerMenuCommand('诊断（排查用）', async () => {
    await refreshLists(true);
    const rows = document.querySelectorAll(
      'tr.topic-list-item, .latest-topic-list-item, .topic-list-body > .topic-list-item'
    );
    const lines = [
      `当前用户：${me || '（没读到，可能没登录或接口失败）'}`,
      `已屏蔽 ${ignored.size} 人：${[...ignored].join(', ') || '（空）'}`,
      `已禁言 ${muted.size} 人：${[...muted].join(', ') || '（空）'}`,
      `本页找到主题行：${rows.length} 个，其中已隐藏 ${document.querySelectorAll('[data-block-hidden]').length} 个`,
      '前 8 行识别出的楼主：',
    ];
    [...rows].slice(0, 8).forEach((row, i) => {
      const title = (row.querySelector('.title, .raw-topic-link, a[href*="/t/"]') || {}).textContent || '';
      lines.push(`${i + 1}. ${topicAuthor(row) || '（没识别出）'} — ${title.trim().slice(0, 30)}`);
    });
    console.log('[屏蔽增强] 诊断\n' + lines.join('\n'));
    if (rows[0]) console.log('[屏蔽增强] 第一行 HTML：', rows[0].outerHTML);
    alert(lines.join('\n'));
  });

  function start() {
    const el = document.getElementById('data-preloaded');
    if (el) { preloadWatcher.disconnect(); readPreloaded(el); }
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    scan();
    refreshLists(true); // 每次打开页面都重新拉一次，避免在论坛设置里改了名单后缓存没更新
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
