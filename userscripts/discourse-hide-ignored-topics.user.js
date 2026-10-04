// ==UserScript==
// @name         美卡论坛屏蔽增强：首页右栏隐藏被屏蔽用户的主题 + 用户卡片屏蔽按钮
// @namespace    https://github.com/laraliang1225/claude
// @version      3.0.3
// @description  论坛自己会在普通主题列表里隐藏被屏蔽用户的主题，但首页“类别 + 最新”右栏漏掉了，这个脚本补上；另外在用户卡片上加“屏蔽 / 取消屏蔽”按钮。
// @match        https://www.uscardforum.com/*
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const W = unsafeWindow;
  const norm = (s) => String(s || '').toLowerCase();
  let me = '';
  let ignored = new Set(); // 屏蔽名单（小写用户名）
  const opByTopic = new Map(); // 主题 ID → 楼主（小写）

  // 被屏蔽楼主的主题写成 CSS 规则，行一渲染出来就是隐藏的
  const style = document.createElement('style');
  function updateStyle() {
    const ids = [...opByTopic].filter(([, op]) => ignored.has(op)).map(([id]) => id);
    style.textContent = ids.length
      ? ids.map((id) => `.latest-topic-list-item[data-topic-id="${id}"]`).join(',') + '{display:none!important}'
      : '';
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  }

  // 从主题列表数据里记下楼主：posters 里标着“原始发帖人”的那个
  function learn(data) {
    const topics = data && data.topic_list && data.topic_list.topics;
    if (!topics) return;
    const users = new Map((data.users || []).map((u) => [u.id, u.username]));
    for (const t of topics) {
      const p = (t.posters || []).find((x) => /原始|Original/i.test(x.description)) || (t.posters || [])[0];
      if (p && users.has(p.user_id)) opByTopic.set(String(t.id), norm(users.get(p.user_id)));
    }
    updateStyle();
  }

  // 首次打开：首屏数据和当前用户（含屏蔽名单）都嵌在 #data-preloaded 里，不用额外请求。
  // 新版 Discourse 是 <script type="application/json" id="data-preloaded">，数据在文本内容里；
  // 旧版放在 data-preloaded 属性里。页面还在加载时文本可能不完整，解析失败就返回 false 等下次再读。
  let preloadedRead = false;
  function readPreloaded(el) {
    if (preloadedRead) return true;
    let pre;
    try { pre = JSON.parse(el.dataset.preloaded || el.textContent); } catch (e) { return false; }
    preloadedRead = true;
    if (pre.currentUser) {
      const user = JSON.parse(pre.currentUser);
      me = user.username;
      ignored = new Set((user.ignored_users || []).map(norm));
    }
    if (pre.topic_list) learn(JSON.parse(pre.topic_list));
    return true;
  }
  const watcher = new MutationObserver(() => {
    const el = document.getElementById('data-preloaded');
    if (el && readPreloaded(el)) watcher.disconnect();
  });
  watcher.observe(document, { childList: true, subtree: true });

  // 站内跳转回首页：论坛用 jQuery ajax（XHR）拉数据，顺便读响应
  const send = W.XMLHttpRequest.prototype.send;
  W.XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      if (this.responseType === '' && this.responseText.includes('"topic_list"')) {
        try { learn(JSON.parse(this.responseText)); } catch (e) { /* 不是 JSON */ }
      }
    });
    return send.apply(this, args);
  };

  // ---------- 用户卡片屏蔽按钮 ----------

  async function setIgnore(username, ignore) {
    const body = new URLSearchParams({ notification_level: ignore ? 'ignore' : 'normal' });
    // 论坛要求“忽略”必须带过期时间，设成 100 年后
    if (ignore) body.set('expiring_at', new Date(Date.now() + 100 * 365.25 * 864e5).toISOString());
    const res = await fetch(`/u/${encodeURIComponent(username)}/notification_level.json`, {
      method: 'PUT',
      headers: {
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data && data.errors && data.errors.join('\n')) || `HTTP ${res.status}`);
    }
    if (ignore) ignored.add(norm(username));
    else ignored.delete(norm(username));
    updateStyle();
  }

  function render(btn) {
    const blocked = ignored.has(norm(btn.dataset.username));
    // 和 Discourse 自带按钮同样的结构（文字放在 .d-button-label 里），样式才会一致
    btn.className = `btn btn-text ${blocked ? 'btn-default' : 'btn-danger'} block-helper-btn`;
    btn.innerHTML = `<span class="d-button-label">${blocked ? '取消屏蔽' : '屏蔽'}</span>`;
  }

  async function onClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    addCardButton(); // 点击时再核对一次卡片上是谁
    const btn = ev.currentTarget;
    const name = btn.dataset.username;
    const blocked = ignored.has(norm(name));
    if (!confirm(blocked ? `取消屏蔽 ${name}？` : `屏蔽 ${name}？`)) return;
    btn.disabled = true;
    try {
      await setIgnore(name, !blocked);
      render(btn);
    } catch (e) {
      alert(`操作失败：${e.message}`);
    }
    btn.disabled = false;
  }

  function addCardButton() {
    // 卡片容器是 #user-card，class 里带 user-card-{用户名}
    const card = document.getElementById('user-card');
    const cls = card && [...card.classList].find((c) => c.startsWith('user-card-'));
    if (!cls) return;
    const username = cls.slice('user-card-'.length);
    if (norm(username) === norm(me)) return;
    let btn = card.querySelector('.block-helper-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.addEventListener('click', onClick);
      const controls = card.querySelector('.usercard-controls');
      if (controls) controls.appendChild(document.createElement(controls.tagName === 'UL' ? 'li' : 'div')).appendChild(btn);
      else card.appendChild(btn);
    }
    if (btn.dataset.username !== username) {
      btn.dataset.username = username;
      render(btn);
    }
  }

  // 油猴不保证在 document-start 注入（比如刚重新启用脚本时），所以页面已经加载完也要能直接启动
  function start() {
    const el = document.getElementById('data-preloaded');
    watcher.disconnect();
    if (el && !readPreloaded(el)) console.warn('[屏蔽增强] 读不到 #data-preloaded 的数据');
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; addCardButton(); });
    // 换一个人的卡片时 Discourse 可能只改 #user-card 的 class，所以也要监听 class 变化
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    addCardButton();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
