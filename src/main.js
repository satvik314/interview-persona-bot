import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './style.css';
import { ROLES, getRole } from './roles.js';
import { MODEL, streamChat } from './gemini.js';

marked.setOptions({ gfm: true, breaks: true });

const KEY_STORAGE = 'aia.geminiKey';
const ROLE_STORAGE = 'aia.activeRole';

// ---------- State ----------
const state = {
  apiKey: localStorage.getItem(KEY_STORAGE) || sessionStorage.getItem(KEY_STORAGE) || '',
  activeRole: getRole(localStorage.getItem(ROLE_STORAGE)).id,
  /** @type {Record<string, {id: string, role: 'user'|'model', text: string, error?: boolean, pending?: boolean}[]>} */
  chats: {},
  /** @type {Record<string, AbortController>} */
  inflight: {},
};

let idCounter = 0;
const newId = () => `m${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function greetingFor(roleId) {
  return { id: newId(), role: 'model', text: getRole(roleId).greeting, greeting: true };
}

ROLES.forEach((r) => {
  state.chats[r.id] = [greetingFor(r.id)];
});

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const els = {
  roles: $('#roles'),
  messages: $('#messages'),
  starters: $('#starters'),
  composer: $('#composer'),
  input: $('#input'),
  sendBtn: $('#send-btn'),
  resetBtn: $('#reset-btn'),
  roleIcon: $('#chat-role-icon'),
  roleTitle: $('#chat-role-title'),
  roleTagline: $('#chat-role-tagline'),
  keyPill: $('#key-pill'),
  keyPillLabel: $('#key-pill-label'),
  modelName: $('#model-name'),
  modal: $('#key-modal'),
  keyForm: $('#key-form'),
  keyInput: $('#key-input'),
  keyToggle: $('#key-toggle'),
  keyRemember: $('#key-remember'),
  keyError: $('#key-error'),
  keyClear: $('#key-clear'),
  keyCancel: $('#key-cancel'),
};

els.modelName.textContent = MODEL;

// ---------- Rendering ----------
const renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text));

function renderRoleTabs() {
  els.roles.innerHTML = '';
  ROLES.forEach((role, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'role-btn';
    btn.setAttribute('role', 'tab');
    btn.dataset.role = role.id;
    btn.style.setProperty('--r-primary', role.theme.primary);
    btn.style.setProperty('--r-secondary', role.theme.secondary);
    btn.style.setProperty('--r-glow', role.theme.glow);
    btn.innerHTML = `
      <span class="role-index">Job ${i + 1}</span>
      <span class="role-icon" aria-hidden="true">${role.icon}</span>
      <span class="role-name">${role.title}</span>
    `;
    btn.addEventListener('click', () => setActiveRole(role.id));
    els.roles.appendChild(btn);
  });
}

function applyTheme(role) {
  const root = document.documentElement;
  root.style.setProperty('--primary', role.theme.primary);
  root.style.setProperty('--secondary', role.theme.secondary);
  root.style.setProperty('--glow', role.theme.glow);
  root.style.setProperty('--soft', role.theme.soft);
  root.dataset.role = role.id;
}

function messageEl(msg) {
  const row = document.createElement('div');
  row.className = `msg-row ${msg.role === 'user' ? 'from-user' : 'from-bot'}`;
  row.dataset.id = msg.id;

  if (msg.role !== 'user') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = getRole(state.activeRole).icon;
    row.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (msg.error) bubble.classList.add('is-error');
  fillBubble(bubble, msg);
  row.appendChild(bubble);
  return row;
}

function fillBubble(bubble, msg) {
  if (msg.role === 'user') {
    bubble.textContent = msg.text;
    return;
  }
  if (msg.pending && !msg.text) {
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    return;
  }
  bubble.innerHTML = renderMarkdown(msg.text);
  if (msg.pending) bubble.insertAdjacentHTML('beforeend', '<span class="cursor" aria-hidden="true"></span>');
}

function renderMessages() {
  const msgs = state.chats[state.activeRole];
  els.messages.innerHTML = '';
  msgs.forEach((m) => els.messages.appendChild(messageEl(m)));
  scrollToBottom(true);
}

function updateMessage(roleId, msg) {
  if (roleId !== state.activeRole) return;
  const row = els.messages.querySelector(`[data-id="${msg.id}"]`);
  if (!row) return;
  const bubble = row.querySelector('.bubble');
  bubble.classList.toggle('is-error', !!msg.error);
  fillBubble(bubble, msg);
  scrollToBottom();
}

function scrollToBottom(force = false) {
  const el = els.messages;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
}

function renderStarters() {
  const role = getRole(state.activeRole);
  const msgs = state.chats[role.id];
  const fresh = msgs.length === 1 && msgs[0].greeting;
  els.starters.innerHTML = '';
  els.starters.hidden = !fresh;
  if (!fresh) return;
  role.starters.forEach((text) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = text;
    chip.addEventListener('click', () => send(text));
    els.starters.appendChild(chip);
  });
}

function renderHeader() {
  const role = getRole(state.activeRole);
  els.roleIcon.textContent = role.icon;
  els.roleTitle.textContent = role.title;
  els.roleTagline.textContent = role.tagline;
  els.roles.querySelectorAll('.role-btn').forEach((b) => {
    const active = b.dataset.role === role.id;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
}

function renderComposer() {
  const busy = !!state.inflight[state.activeRole];
  els.sendBtn.classList.toggle('is-stop', busy);
  els.sendBtn.setAttribute('aria-label', busy ? 'Stop generating' : 'Send message');
  els.sendBtn.innerHTML = busy
    ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6l-.01 6.53L15 12 3.39 13.87z"/></svg>';
}

function renderKeyPill() {
  const has = !!state.apiKey;
  els.keyPill.classList.toggle('has-key', has);
  els.keyPillLabel.textContent = has ? `Key ••••${state.apiKey.slice(-4)}` : 'Add API key';
}

function renderAll() {
  renderHeader();
  renderMessages();
  renderStarters();
  renderComposer();
  renderKeyPill();
}

// ---------- Actions ----------
function setActiveRole(roleId) {
  if (roleId === state.activeRole) return;
  state.activeRole = roleId;
  localStorage.setItem(ROLE_STORAGE, roleId);
  applyTheme(getRole(roleId));

  els.messages.classList.remove('swap');
  void els.messages.offsetWidth; // restart the swap animation
  els.messages.classList.add('swap');

  renderAll();
  els.input.focus();
}

async function send(rawText) {
  const text = rawText.trim();
  if (!text) return;
  if (!state.apiKey) {
    openKeyModal('Add your Gemini API key to start chatting.');
    return;
  }
  const roleId = state.activeRole;
  if (state.inflight[roleId]) return;

  const role = getRole(roleId);
  const chat = state.chats[roleId];

  // Drop a previous error bubble so it isn't sent as context.
  if (chat.length && chat[chat.length - 1].error) chat.pop();

  chat.push({ id: newId(), role: 'user', text });
  const reply = { id: newId(), role: 'model', text: '', pending: true };
  chat.push(reply);

  els.input.value = '';
  autosize();

  const controller = new AbortController();
  state.inflight[roleId] = controller;
  renderMessages();
  renderStarters();
  renderComposer();

  // Gemini requires the conversation to start with a user turn, so the local
  // greeting is skipped; the persona lives in the system instruction.
  const history = chat
    .filter((m) => m !== reply && !m.greeting && !m.error && m.text)
    .map((m) => ({ role: m.role, text: m.text }));

  try {
    await streamChat({
      apiKey: state.apiKey,
      system: role.system,
      history,
      signal: controller.signal,
      onChunk: (chunk) => {
        reply.text += chunk;
        updateMessage(roleId, reply);
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (!reply.text) reply.text = '_Stopped._';
    } else {
      if (reply.text) {
        reply.text += `\n\n_⚠️ ${err.message}_`;
      } else {
        reply.text = `⚠️ ${err.message}`;
        reply.error = true;
      }
      if (err.status === 400 || err.status === 401 || err.status === 403) {
        if (/key/i.test(err.message)) openKeyModal(err.message);
      }
    }
  } finally {
    reply.pending = false;
    delete state.inflight[roleId];
    updateMessage(roleId, reply);
    if (roleId === state.activeRole) renderComposer();
  }
}

function resetChat() {
  const roleId = state.activeRole;
  state.inflight[roleId]?.abort();
  delete state.inflight[roleId];
  state.chats[roleId] = [greetingFor(roleId)];
  renderAll();
  els.input.focus();
}

// ---------- API key modal ----------
function openKeyModal(errorMsg = '') {
  els.keyInput.value = state.apiKey;
  els.keyInput.type = 'password';
  els.keyToggle.textContent = 'Show';
  els.keyRemember.checked = !!localStorage.getItem(KEY_STORAGE) || !state.apiKey;
  els.keyError.textContent = errorMsg;
  els.keyError.hidden = !errorMsg;
  els.keyClear.hidden = !state.apiKey;
  els.keyCancel.hidden = !state.apiKey;
  els.modal.hidden = false;
  requestAnimationFrame(() => els.keyInput.focus());
}

function closeKeyModal() {
  els.modal.hidden = true;
  els.input.focus();
}

function saveKey(key, remember) {
  state.apiKey = key;
  localStorage.removeItem(KEY_STORAGE);
  sessionStorage.removeItem(KEY_STORAGE);
  if (key) (remember ? localStorage : sessionStorage).setItem(KEY_STORAGE, key);
  renderKeyPill();
}

els.keyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = els.keyInput.value.trim();
  if (!key) {
    els.keyError.textContent = 'Please paste your Gemini API key.';
    els.keyError.hidden = false;
    return;
  }
  saveKey(key, els.keyRemember.checked);
  closeKeyModal();
});

els.keyToggle.addEventListener('click', () => {
  const show = els.keyInput.type === 'password';
  els.keyInput.type = show ? 'text' : 'password';
  els.keyToggle.textContent = show ? 'Hide' : 'Show';
});

els.keyClear.addEventListener('click', () => {
  saveKey('', false);
  els.keyInput.value = '';
  els.keyClear.hidden = true;
  els.keyCancel.hidden = true;
  els.keyInput.focus();
});

els.keyCancel.addEventListener('click', () => {
  if (state.apiKey) closeKeyModal();
});

els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal && state.apiKey) closeKeyModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.modal.hidden && state.apiKey) closeKeyModal();
});

els.keyPill.addEventListener('click', () => openKeyModal());

// ---------- Composer ----------
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
}

els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const controller = state.inflight[state.activeRole];
  if (controller) {
    controller.abort();
    return;
  }
  send(els.input.value);
});

els.resetBtn.addEventListener('click', resetChat);

// ---------- Boot ----------
renderRoleTabs();
applyTheme(getRole(state.activeRole));
renderAll();
if (!state.apiKey) openKeyModal();
