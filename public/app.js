'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const loginScreen = $('login-screen');
  const chatScreen = $('chat-screen');
  const loginForm = $('login-form');
  const usernameEl = $('username');
  const passwordEl = $('password');
  const loginBtn = $('login-btn');
  const loginError = $('login-error');
  const headerUser = $('header-user');
  const statusEl = $('status');
  const logoutBtn = $('logout-btn');
  const messagesEl = $('messages');
  const messageForm = $('message-form');
  const messageInput = $('message-input');
  const sendBtn = $('send-btn');

  let socket = null;
  let me = '';
  let ttl = 30 * 60 * 1000;
  const shown = new Set();

  const emptyEl = document.createElement('p');
  emptyEl.className = 'empty';
  emptyEl.textContent = 'لا توجد رسائل بعد · No messages yet';

  function showScreen(name) {
    loginScreen.classList.toggle('hidden', name !== 'login');
    chatScreen.classList.toggle('hidden', name !== 'chat');
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    return { ok: res.ok, data };
  }

  // ---------- عرض الرسائل (textContent فقط لمنع XSS) ----------
  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  function updateEmpty() {
    const hasMsgs = messagesEl.querySelector('.msg') !== null;
    if (hasMsgs && emptyEl.parentNode) emptyEl.remove();
    if (!hasMsgs && !emptyEl.parentNode) messagesEl.appendChild(emptyEl);
  }

  function addMessage(m) {
    if (shown.has(m.id)) return;
    shown.add(m.id);

    const stick = isNearBottom() || m.from === me;
    const mine = m.from === me;

    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (mine ? 'mine' : 'theirs');
    wrap.dataset.id = m.id;
    wrap.dataset.ts = String(m.ts);

    if (!mine) {
      const name = document.createElement('div');
      name.className = 'msg-name';
      name.textContent = m.from;
      wrap.appendChild(name);
    }

    const text = document.createElement('div');
    text.className = 'msg-text';
    text.setAttribute('dir', 'auto');
    text.textContent = m.text;
    wrap.appendChild(text);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = new Date(m.ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    wrap.appendChild(time);

    messagesEl.appendChild(wrap);
    updateEmpty();
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeById(id) {
    const el = messagesEl.querySelector('.msg[data-id="' + id + '"]');
    if (el) el.remove();
    shown.delete(id);
    updateEmpty();
  }

  function clearMessages() {
    messagesEl.textContent = '';
    shown.clear();
    updateEmpty();
  }

  // حذف محلي احتياطي بعد انتهاء المدة
  setInterval(() => {
    const now = Date.now();
    messagesEl.querySelectorAll('.msg').forEach((el) => {
      if (Number(el.dataset.ts) + ttl <= now) {
        shown.delete(el.dataset.id);
        el.remove();
      }
    });
    updateEmpty();
  }, 5000);

  // ---------- الاتصال ----------
  function setStatus(text) {
    statusEl.textContent = text;
  }

  function startChat(username) {
    me = username;
    headerUser.textContent = username;
    clearMessages();
    showScreen('chat');
    setStatus('جاري الاتصال... · Connecting...');

    if (socket) socket.disconnect();
    socket = io();

    socket.on('connect', () => {
      setStatus('متصل · Connected');
      sendBtn.disabled = false;
    });

    socket.on('disconnect', () => {
      setStatus('انقطع الاتصال · Disconnected');
      sendBtn.disabled = true;
    });

    socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') {
        goToLogin();
      } else {
        setStatus('إعادة المحاولة... · Retrying...');
      }
    });

    socket.on('history', (data) => {
      ttl = data.ttl || ttl;
      clearMessages();
      data.messages.forEach(addMessage);
    });

    socket.on('message', addMessage);

    socket.on('expired', (ids) => {
      ids.forEach(removeById);
    });
  }

  function goToLogin() {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    me = '';
    clearMessages();
    passwordEl.value = '';
    showScreen('login');
  }

  // ---------- الأحداث ----------
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    loginBtn.disabled = true;
    try {
      const { ok, data } = await api('/api/login', {
        username: usernameEl.value,
        password: passwordEl.value
      });
      if (ok) {
        passwordEl.value = '';
        startChat(data.username);
      } else {
        loginError.textContent = data.error || 'حدث خطأ';
      }
    } catch (err) {
      loginError.textContent = 'تعذر الاتصال بالخادم';
    } finally {
      loginBtn.disabled = false;
    }
  });

  messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !socket || !socket.connected) return;
    socket.emit('message', text);
    messageInput.value = '';
    messageInput.focus();
  });

  logoutBtn.addEventListener('click', async () => {
    try { await api('/api/logout'); } catch (e) { /* ignore */ }
    goToLogin();
  });

  // ---------- عند فتح الصفحة ----------
  (async function init() {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        startChat(data.username);
        return;
      }
    } catch (e) { /* ignore */ }
    showScreen('login');
  })();
})();
