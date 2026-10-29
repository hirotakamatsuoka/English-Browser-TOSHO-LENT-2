'use strict';
const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, session, protocol, net,
  dialog, shell, clipboard, screen,
} = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ───────── 定数 ─────────
const APP_NAME = 'Portal Browser';
const SCHEME = 'pbrowser';
const HOME_URL = `${SCHEME}://home/`;
const TAB_H = 44;
const TOOL_H = 52;
const WIZARD_BAR_H = 76;
const PRELOAD = path.join(__dirname, 'preload.js');
const PAGES = new Set(['ui', 'find', 'handle', 'lock', 'wizard', 'home', 'history', 'bookmarks', 'downloads', 'settings', 'error']);

const DEFAULT_FAVORITES = [
  { title: '1年英語', url: 'https://eig-tm.dgc.tsho.jp/r7/eig2/000/c1/c1/top/index.html?g=3' },
  { title: '2年英語', url: 'https://eig-tm.dgc.tsho.jp/r7/eig2/000/c2/c2/top/index.html?g=2' },
  { title: '3年英語', url: 'https://eig-tm.dgc.tsho.jp/r7/eig2/000/c3/c3/top/index.html?g=3' },
  { title: 'Google', url: 'https://www.google.com/' },
  { title: 'Lentrance', url: 'https://www.lentrance.com/reader/portal.html' },
];

const PORTALS = [
  { name: 'Lentrance', url: 'https://www.lentrance.com/reader/portal.html' },
  { name: '1年英語', url: 'https://eig-tm.dgc.tsho.jp/login/r7/eig2/000/c1/login.html' },
  { name: '2年英語', url: 'https://eig-tm.dgc.tsho.jp/login/r7/eig2/000/c2/login.html' },
  { name: '3年英語', url: 'https://eig-tm.dgc.tsho.jp/login/r7/eig2/000/c3/login.html' },
];

const PRESETS = {
  day: { label: '日中', start: '08:00', end: '18:00' },
  morning: { label: '午前', start: '06:00', end: '12:40' },
  afternoon: { label: '午後', start: '13:15', end: '18:00' },
};

const SEARCH = {
  google: ['Google', 'https://www.google.com/search?q='],
  bing: ['Bing', 'https://www.bing.com/search?q='],
  duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q='],
  yahoo: ['Yahoo! JAPAN', 'https://search.yahoo.co.jp/search?p='],
};

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// Googleログインなどで弾かれないよう、UAから Electron とアプリ名を外す
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/\S+/, '')
  .replace(/ [\w.-]+\/\d[\w.]* (?=Chrome\/)/, ' ');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ───────── 保存データ ─────────
let settings, bookmarks, history, downloads;
const pending = new Map();

const dataPath = (n) => path.join(app.getPath('userData'), n);
function readJSON(n, def) {
  try { return JSON.parse(fs.readFileSync(dataPath(n), 'utf8')); } catch { return def; }
}
function save(n, data, delay = 500) {
  const p = pending.get(n);
  if (p) clearTimeout(p.t);
  pending.set(n, { data, t: setTimeout(() => flush(n), delay) });
}
function flush(n) {
  const p = pending.get(n);
  if (!p) return;
  clearTimeout(p.t);
  pending.delete(n);
  try {
    const f = dataPath(n);
    fs.writeFileSync(f + '.tmp', JSON.stringify(p.data));
    fs.renameSync(f + '.tmp', f);
  } catch (e) { console.error('save failed', n, e); }
}
function flushAll() { for (const n of [...pending.keys()]) flush(n); }
const saveSettings = () => save('settings.json', settings);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function loadData() {
  const s = readJSON('settings.json', {});
  settings = {
    setupDone: false,
    userName: '',
    favorites: DEFAULT_FAVORITES.map((f) => ({ ...f })),
    hideBars: false,
    pin: null,
    restoreTabs: true,
    searchEngine: 'google',
    tabs: [],
    permissions: {},
    window: null,
    ...s,
  };
  settings.usage = { mode: 'none', start: '08:00', end: '18:00', ...(s.usage || {}) };
  if (s.hideBars === undefined && (s.hideToolbar || s.hideTabbar)) settings.hideBars = true;
  delete settings.hideToolbar;
  delete settings.hideTabbar;
  bookmarks = readJSON('bookmarks.json', []);
  history = readJSON('history.json', []);
  downloads = readJSON('downloads.json', []).map((d) => (d.state === 'progressing' || d.state === 'paused' ? { ...d, state: 'interrupted' } : d));
}

// ───────── 利用時間 ─────────
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function usageRange(u) {
  if (u.mode === 'none') return null;
  if (u.mode === 'custom') return { start: u.start, end: u.end };
  return PRESETS[u.mode] || null;
}
function isAllowedNow() {
  const r = usageRange(settings.usage);
  if (!r) return true;
  const d = new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  const a = toMin(r.start), b = toMin(r.end);
  if (a === b) return false;
  return a <= b ? now >= a && now < b : now >= a || now < b;
}
function rangeLabel() {
  const r = usageRange(settings.usage);
  if (!r) return 'いつでも';
  const f = (s) => { const [h, m] = s.split(':'); return `${Number(h)}:${m}`; };
  return `${f(r.start)}〜${f(r.end)}`;
}
function validUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const modes = ['none', 'day', 'morning', 'afternoon', 'custom'];
  if (!modes.includes(u.mode)) return null;
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  const out = { mode: u.mode, start: settings.usage.start, end: settings.usage.end };
  if (u.mode === 'custom') {
    if (!re.test(u.start) || !re.test(u.end) || u.start === u.end) return null;
    out.start = u.start; out.end = u.end;
  }
  return out;
}

// ───────── 状態 ─────────
let win = null, uiView = null, findView = null, handleView = null, wizView = null, portalView = null, lockView = null;
let attached = [];
let tabs = [], activeId = null, nextTabId = 1;
const closedTabs = [];
let findOpen = false, locked = false, wiz = null, htmlFs = false, userFs = false, quitting = false;
let updateStatus = '未確認';
let updater = null;
let tabsTimer = null;
const downloadItems = new Map();

const activeTab = () => tabs.find((t) => t.id === activeId) || null;
const tabById = (id) => tabs.find((t) => t.id === id) || null;
const tabUrl = (t) => t.errorUrl || t.pending || t.url;
const isInternal = (u) => typeof u === 'string' && u.startsWith(`${SCHEME}://`);
const isWeb = (u) => /^https?:/i.test(u || '');
const alive = (wc) => wc && !wc.isDestroyed();

// ───────── URL入力の解釈 ─────────
function normalizeInput(text) {
  text = String(text || '').trim();
  if (!text) return null;
  if (/^(https?|file|pbrowser):\/\//i.test(text) || /^about:blank$/i.test(text)) return text;
  const hostLike = /^(localhost|(\d{1,3}\.){3}\d{1,3}|([\w-]+\.)+[a-z]{2,})(:\d+)?([/?#]\S*)?$/i;
  if (!/\s/.test(text) && hostLike.test(text)) {
    return (/^(localhost|(\d{1,3}\.){3}\d{1,3})/i.test(text) ? 'http://' : 'https://') + text;
  }
  const engine = SEARCH[settings.searchEngine] || SEARCH.google;
  return engine[1] + encodeURIComponent(text);
}

// ───────── ウィンドウ ─────────
function createWindow() {
  const ws = settings.window || {};
  const opts = {
    width: ws.width || 1280, height: ws.height || 800,
    minWidth: 480, minHeight: 360,
    title: APP_NAME, backgroundColor: '#ffffff', autoHideMenuBar: true,
  };
  if (Number.isFinite(ws.x) && Number.isFinite(ws.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return ws.x < b.x + b.width - 40 && ws.x + (ws.width || 0) > b.x + 40 && ws.y >= b.y - 10 && ws.y < b.y + b.height - 40;
    });
    if (visible) { opts.x = ws.x; opts.y = ws.y; }
  }
  win = new BaseWindow(opts);
  if (ws.maximized || !ws.width) win.maximize();

  win.on('resize', render);
  win.on('enter-full-screen', () => { render(); pushState(); });
  win.on('leave-full-screen', () => { userFs = false; render(); pushState(); });
  win.on('close', () => { saveTabsNow(); saveWindowState(); });
  win.on('closed', () => { win = null; });
  win.on('app-command', (_e, cmd) => {
    if (locked || wiz) return;
    const t = activeTab();
    if (!t) return;
    if (cmd === 'browser-backward' && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack();
    if (cmd === 'browser-forward' && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward();
  });

  uiView = makeShellView('ui');
  findView = makeShellView('find', true);
  handleView = makeShellView('handle', true);
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  saveSettings();
}

function makeShellView(page, transparent = false) {
  const v = new WebContentsView({
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  if (transparent) v.setBackgroundColor('#00000000');
  const wc = v.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wireShortcuts(wc);
  wc.loadURL(`${SCHEME}://${page}/`);
  return v;
}

function setChildren(list) {
  const same = list.length === attached.length && list.every((v, i) => v === attached[i]);
  if (same) return;
  for (const v of attached) {
    if (!list.includes(v)) { try { win.contentView.removeChildView(v); } catch { /* 既に外れている */ } }
  }
  for (const v of list) win.contentView.addChildView(v); // 追加し直すと最前面に移る
  attached = list.slice();
}

function chromeHeight() {
  if (htmlFs || settings.hideBars) return 0;
  return TAB_H + TOOL_H;
}

function render() {
  if (!win || win.isDestroyed()) return;
  const { width: W, height: H } = win.getContentBounds();
  const full = { x: 0, y: 0, width: W, height: H };

  if (locked && lockView) {
    lockView.setBounds(full);
    setChildren([lockView]);
    return;
  }
  if (wiz && wizView) {
    if (wiz.step === 'portal' && portalView) {
      portalView.setBounds({ x: 0, y: 0, width: W, height: Math.max(0, H - WIZARD_BAR_H) });
      wizView.setBounds({ x: 0, y: Math.max(0, H - WIZARD_BAR_H), width: W, height: WIZARD_BAR_H });
      setChildren([portalView, wizView]);
    } else {
      wizView.setBounds(full);
      setChildren([wizView]);
    }
    return;
  }
  const t = activeTab();
  const ch = chromeHeight();
  const list = [];
  if (t) {
    t.view.setBounds({ x: 0, y: ch, width: W, height: Math.max(0, H - ch) });
    list.push(t.view);
  }
  if (ch > 0) {
    uiView.setBounds({ x: 0, y: 0, width: W, height: ch });
    list.push(uiView);
  }
  if (findOpen) {
    findView.setBounds({ x: Math.max(0, W - 392), y: ch, width: 392, height: 72 });
    list.push(findView);
  }
  if (settings.hideBars && !htmlFs) {
    handleView.setBounds({ x: Math.round(W / 2 - 40), y: 0, width: 80, height: 28 });
    list.push(handleView);
  }
  setChildren(list);
  if (t) win.setTitle(`${t.title || '新しいタブ'} - ${APP_NAME}`);
}

// ───────── 状態をUIへ送る ─────────
function snapshot() {
  const t = activeTab();
  const url = t ? tabUrl(t) : '';
  const can = t && !t.pending && alive(t.wc);
  return {
    tabs: tabs.map((x) => ({
      id: x.id,
      title: x.title || (isInternal(tabUrl(x)) ? '' : tabUrl(x)) || '新しいタブ',
      url: tabUrl(x),
      favicon: x.favicon,
      loading: x.loading,
      audible: x.audible,
      muted: alive(x.wc) ? x.wc.isAudioMuted() : false,
      active: x.id === activeId,
    })),
    activeId,
    nav: {
      canGoBack: !!(can && t.wc.navigationHistory.canGoBack()),
      canGoForward: !!(can && t.wc.navigationHistory.canGoForward()),
      loading: !!(t && t.loading),
      display: url.startsWith(HOME_URL) ? '' : url,
      secure: /^https:/i.test(url),
      insecure: /^http:/i.test(url),
      bookmarked: isWeb(url) && bookmarks.some((b) => b.url === url),
    },
    hideBars: settings.hideBars,
    fullscreen: !!(win && win.isFullScreen()),
    downloading: downloads.some((d) => d.state === 'progressing'),
  };
}
function pushState() {
  if (uiView && alive(uiView.webContents)) uiView.webContents.send('state', snapshot());
  const t = activeTab();
  if (win && t && !wiz) win.setTitle(`${t.title || '新しいタブ'} - ${APP_NAME}`);
}
function broadcastInternal(channel, payload) {
  for (const t of tabs) {
    if (alive(t.wc) && isInternal(t.wc.getURL())) t.wc.send(channel, payload);
  }
}

// ───────── タブ ─────────
function createTab(url, opt = {}) {
  const view = new WebContentsView({
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  const tab = {
    id: nextTabId++, view, wc: view.webContents, url, title: opt.title || '', favicon: '',
    loading: false, audible: false, pending: null, errorUrl: null,
  };
  let idx = tabs.length;
  if (opt.afterActive) {
    const i = tabs.findIndex((t) => t.id === activeId);
    if (i >= 0) idx = i + 1;
  }
  tabs.splice(idx, 0, tab);
  wireTab(tab);
  if (opt.lazy) tab.pending = url;
  else tab.wc.loadURL(url).catch(() => {});
  if (opt.activate !== false) activateTab(tab.id);
  else { pushState(); saveTabsSoon(); }
  return tab;
}

function ensureLoaded(t) {
  if (t && t.pending) {
    const u = t.pending;
    t.pending = null;
    t.wc.loadURL(u).catch(() => {});
  }
}

function activateTab(id) {
  const t = tabById(id);
  if (!t) return;
  if (id !== activeId && findOpen) closeFind(true);
  activeId = id;
  ensureLoaded(t);
  render();
  pushState();
  if (!locked && !wiz) t.wc.focus();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = tabs[i];
  const u = tabUrl(t);
  if (isWeb(u)) { closedTabs.push(u); if (closedTabs.length > 20) closedTabs.shift(); }
  tabs.splice(i, 1);
  if (id === activeId) {
    if (findOpen) closeFind(true);
    const n = tabs[i] || tabs[i - 1];
    activeId = n ? n.id : null;
    if (n) ensureLoaded(n);
  }
  if (!tabs.length) createTab(HOME_URL);
  render();
  pushState();
  saveTabsSoon();
  try { t.wc.close(); } catch { /* 破棄済み */ }
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  activateTab(tabs[(i + dir + tabs.length) % tabs.length].id);
}
function selectTabIndex(n) {
  if (!tabs.length) return;
  activateTab((n >= tabs.length || n < 0 ? tabs[tabs.length - 1] : tabs[n]).id);
}
function reopenTab() {
  const u = closedTabs.pop();
  if (u) createTab(u);
}
function openInternal(name) {
  const base = `${SCHEME}://${name}/`;
  const ex = tabs.find((t) => tabUrl(t).startsWith(base));
  if (ex) activateTab(ex.id);
  else createTab(base, { afterActive: true });
}
function goHome() {
  const t = activeTab();
  if (t) { t.errorUrl = null; t.wc.loadURL(HOME_URL).catch(() => {}); }
}

function saveTabsNow() {
  clearTimeout(tabsTimer);
  settings.tabs = tabs
    .filter((t) => isWeb(tabUrl(t)))
    .map((t) => ({ url: tabUrl(t), title: t.title }));
  saveSettings();
}
function saveTabsSoon() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(saveTabsNow, 1500);
}

function recordHistory(tab, url) {
  if (!isWeb(url)) return;
  const now = Date.now();
  const last = history[0];
  if (last && last.url === url && now - last.time < 60000) last.time = now;
  else history.unshift({ id: uid(), url, title: tab.title || url, time: now });
  if (history.length > 5000) history.length = 5000;
  save('history.json', history, 3000);
}
function touchHistoryTitle(tab) {
  if (!tab.title) return;
  const h = history.slice(0, 5).find((x) => x.url === tab.url);
  if (h) { h.title = tab.title; save('history.json', history, 3000); }
}

function wireTab(tab) {
  const wc = tab.wc;
  wireShortcuts(wc);
  wc.setVisualZoomLevelLimits(1, 4); // タッチ操作のピンチ拡大

  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (/^(https?:|about:blank)/i.test(url)) {
      createTab(url, { activate: disposition !== 'background-tab', afterActive: true });
    }
    return { action: 'deny' };
  });

  // 外部サイトから内部ページ（pbrowser://）へは遷移させない
  const guard = (e, url) => {
    if (isInternal(url) && !isInternal(wc.getURL())) e.preventDefault();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);

  wc.on('page-title-updated', (_e, title) => { tab.title = title; touchHistoryTitle(tab); pushState(); saveTabsSoon(); });
  wc.on('page-favicon-updated', (_e, favs) => { tab.favicon = favs[0] || ''; pushState(); });
  wc.on('did-start-loading', () => { tab.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; pushState(); });
  wc.on('audio-state-changed', () => { tab.audible = wc.isCurrentlyAudible(); pushState(); });

  wc.on('did-navigate', (_e, url) => {
    tab.url = url;
    if (!url.startsWith(`${SCHEME}://error/`)) tab.errorUrl = null;
    tab.title = '';
    tab.favicon = '';
    recordHistory(tab, url);
    pushState();
    saveTabsSoon();
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = url;
    recordHistory(tab, url);
    pushState();
    saveTabsSoon();
  });
  wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (validatedURL.startsWith(`${SCHEME}://error/`)) return;
    tab.errorUrl = validatedURL;
    wc.loadURL(`${SCHEME}://error/?u=${encodeURIComponent(validatedURL)}&d=${encodeURIComponent(desc)}`).catch(() => {});
  });
  wc.on('render-process-gone', () => {
    tab.errorUrl = tab.url;
    wc.loadURL(`${SCHEME}://error/?u=${encodeURIComponent(tab.url)}&d=${encodeURIComponent('PAGE_CRASHED')}`).catch(() => {});
  });

  wc.on('context-menu', (_e, params) => showContextMenu(tab, params));
  wc.on('found-in-page', (_e, r) => {
    if (tab.id === activeId && findView && alive(findView.webContents)) {
      findView.webContents.send('find:result', { active: r.activeMatchOrdinal, total: r.matches });
    }
  });
  wc.on('zoom-changed', (_e, dir) => stepZoom(dir === 'in' ? 1 : -1, tab));
  wc.on('enter-html-full-screen', () => { htmlFs = true; if (win) win.setFullScreen(true); render(); });
  wc.on('leave-html-full-screen', () => {
    htmlFs = false;
    if (win && !userFs) win.setFullScreen(false);
    render();
  });
}

// ───────── 操作 ─────────
function stepZoom(dir, tab = activeTab()) {
  if (!tab) return;
  const wc = tab.wc;
  if (dir === 0) { wc.setZoomFactor(1); return; }
  const cur = wc.getZoomFactor();
  let i = ZOOM_STEPS.reduce((best, z, k) => (Math.abs(z - cur) < Math.abs(ZOOM_STEPS[best] - cur) ? k : best), 0);
  i = Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir));
  wc.setZoomFactor(ZOOM_STEPS[i]);
}

function reloadActive(hard) {
  const t = activeTab();
  if (!t) return;
  ensureLoaded(t);
  if (t.errorUrl) { t.wc.loadURL(t.errorUrl).catch(() => {}); return; }
  if (hard) t.wc.reloadIgnoringCache(); else t.wc.reload();
}

function toggleFullscreen() {
  if (!win) return;
  userFs = !win.isFullScreen();
  win.setFullScreen(userFs);
}

function setHideBars(value) {
  settings.hideBars = !!value;
  saveSettings();
  render();
  pushState();
  broadcastInternal('settings:changed');
}

function focusAddress() {
  if (settings.hideBars) setHideBars(false);
  uiView.webContents.focus();
  uiView.webContents.send('focus-address');
}

function toggleBookmark() {
  const t = activeTab();
  if (!t) return;
  const url = tabUrl(t);
  if (!isWeb(url)) return;
  const i = bookmarks.findIndex((b) => b.url === url);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.unshift({ id: uid(), title: t.title || url, url, added: Date.now() });
  save('bookmarks.json', bookmarks);
  pushState();
  broadcastInternal('bookmarks:changed');
}

function addCurrentToHome() {
  const t = activeTab();
  if (!t) return;
  const url = tabUrl(t);
  if (!guard() || !isWeb(url) || settings.favorites.length >= 30) return;
  if (settings.favorites.some((f) => f.url === url)) return;
  let title = t.title;
  if (!title) { try { title = new URL(url).hostname; } catch { title = url; } }
  settings.favorites.push({ title: title.slice(0, 40), url });
  saveSettings();
  broadcastInternal('home:changed');
}

function printPage() {
  const t = activeTab();
  if (t) t.wc.print({ printBackground: true });
}
async function savePage() {
  const t = activeTab();
  if (!t || !win) return;
  const base = (t.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), `${base}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (!r.canceled && r.filePath) t.wc.savePage(r.filePath, 'HTMLComplete').catch(() => {});
}
function openDevTools() {
  const t = activeTab();
  if (t) t.wc.openDevTools({ mode: 'detach' });
}

// ページ内検索
function openFind() {
  if (!activeTab()) return;
  findOpen = true;
  render();
  findView.webContents.focus();
  findView.webContents.send('find:open');
}
function closeFind(silent) {
  if (!findOpen) return;
  findOpen = false;
  const t = activeTab();
  if (t && alive(t.wc)) t.wc.stopFindInPage('clearSelection');
  if (!silent) { render(); if (t) t.wc.focus(); }
}

// ───────── ショートカット ─────────
function wireShortcuts(wc) {
  wc.on('before-input-event', (e, input) => { if (handleKey(input)) e.preventDefault(); });
}

function handleKey(input) {
  if (input.type !== 'keyDown' || locked || wiz || !win) return false;
  const c = input.control || input.meta, s = input.shift, a = input.alt;
  const k = input.key;
  const kl = k.length === 1 ? k.toLowerCase() : k;

  if (c && !a) {
    switch (kl) {
      case 't': if (s) reopenTab(); else createTab(HOME_URL); return true;
      case 'w': case 'F4': { const t = activeTab(); if (t) closeTab(t.id); return true; }
      case 'r': reloadActive(s); return true;
      case 'l': focusAddress(); return true;
      case 'f': openFind(); return true;
      case 'd': toggleBookmark(); return true;
      case 'h': if (s) setHideBars(!settings.hideBars); else openInternal('history'); return true;
      case 'j': openInternal('downloads'); return true;
      case 'o': if (s) { openInternal('bookmarks'); return true; } break;
      case 'p': printPage(); return true;
      case 's': savePage(); return true;
      case 'i': if (s) { openDevTools(); return true; } break;
      case 'Delete': if (s) { openInternal('settings'); return true; } break;
      case 'Tab': cycleTab(s ? -1 : 1); return true;
      case 'PageDown': cycleTab(1); return true;
      case 'PageUp': cycleTab(-1); return true;
      case '+': case '=': stepZoom(1); return true;
      case '-': case '_': stepZoom(-1); return true;
      case '0': stepZoom(0); return true;
      case 'F5': reloadActive(true); return true;
      default: break;
    }
    if (/^[1-9]$/.test(kl)) { selectTabIndex(kl === '9' ? -1 : Number(kl) - 1); return true; }
    return false;
  }
  if (a && !c) {
    const t = activeTab();
    if (k === 'ArrowLeft') { if (t && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack(); return true; }
    if (k === 'ArrowRight') { if (t && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward(); return true; }
    if (k === 'Home') { goHome(); return true; }
    if (kl === 'd') { focusAddress(); return true; }
    return false;
  }
  switch (k) {
    case 'F5': reloadActive(false); return true;
    case 'F6': focusAddress(); return true;
    case 'F11': toggleFullscreen(); return true;
    case 'F12': openDevTools(); return true;
    case 'Escape': if (findOpen) { closeFind(); return true; } return false;
    default: return false;
  }
}

// ───────── メニュー ─────────
const acc = (a) => ({ accelerator: a, registerAccelerator: false });

function showMainMenu(x, y) {
  const t = activeTab();
  if (!t || !win) return;
  const z = Math.round(t.wc.getZoomFactor() * 100);
  const url = tabUrl(t);
  const tpl = [
    { label: '新しいタブ', ...acc('CmdOrCtrl+T'), click: () => createTab(HOME_URL) },
    { label: '閉じたタブを開く', ...acc('CmdOrCtrl+Shift+T'), enabled: closedTabs.length > 0, click: reopenTab },
    { type: 'separator' },
    { label: '履歴', ...acc('CmdOrCtrl+H'), click: () => openInternal('history') },
    { label: 'ダウンロード', ...acc('CmdOrCtrl+J'), click: () => openInternal('downloads') },
    { label: 'ブックマーク', ...acc('CmdOrCtrl+Shift+O'), click: () => openInternal('bookmarks') },
    { type: 'separator' },
    {
      label: `ズーム（${z}%）`,
      submenu: [
        { label: '拡大', ...acc('CmdOrCtrl+Plus'), click: () => stepZoom(1) },
        { label: '縮小', ...acc('CmdOrCtrl+-'), click: () => stepZoom(-1) },
        { label: '100%に戻す', ...acc('CmdOrCtrl+0'), click: () => stepZoom(0) },
      ],
    },
    { label: '印刷...', ...acc('CmdOrCtrl+P'), click: printPage },
    { label: 'ページを保存...', ...acc('CmdOrCtrl+S'), click: savePage },
    { label: 'ページ内を検索...', ...acc('CmdOrCtrl+F'), click: openFind },
    { label: 'このページをホームのお気に入りに追加', enabled: isWeb(url) && isUnlocked(), click: addCurrentToHome },
    { type: 'separator' },
    { label: 'タブバーとツールバーを隠す', type: 'checkbox', checked: settings.hideBars, ...acc('CmdOrCtrl+Shift+H'), click: () => setHideBars(!settings.hideBars) },
    { label: '全画面表示（Windowsのタスクバーも隠れます）', type: 'checkbox', checked: win.isFullScreen(), ...acc('F11'), click: toggleFullscreen },
    { label: '開発者ツール', ...acc('F12'), click: openDevTools },
    { type: 'separator' },
    { label: '設定', ...acc('CmdOrCtrl+Shift+Delete'), click: () => openInternal('settings') },
    { label: '終了', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

function showTabMenu(id) {
  const t = tabById(id);
  if (!t || !win) return;
  const i = tabs.indexOf(t);
  const tpl = [
    { label: '新しいタブ', click: () => createTab(HOME_URL, { afterActive: false }) },
    { label: '再読み込み', click: () => { activateTab(id); reloadActive(false); } },
    { label: 'タブを複製', click: () => createTab(tabUrl(t), { afterActive: true }) },
    { label: t.wc.isAudioMuted() ? 'サイトのミュートを解除' : 'サイトをミュート', click: () => { t.wc.setAudioMuted(!t.wc.isAudioMuted()); pushState(); } },
    { type: 'separator' },
    { label: 'タブを閉じる', click: () => closeTab(id) },
    { label: '他のタブを閉じる', enabled: tabs.length > 1, click: () => tabs.filter((x) => x.id !== id).forEach((x) => closeTab(x.id)) },
    { label: '右側のタブを閉じる', enabled: i < tabs.length - 1, click: () => tabs.slice(i + 1).forEach((x) => closeTab(x.id)) },
    { label: '閉じたタブを開く', enabled: closedTabs.length > 0, click: reopenTab },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

function showContextMenu(tab, params) {
  if (!win) return;
  const wc = tab.wc;
  const T = [];
  const add = (label, click, extra = {}) => T.push({ label, click, ...extra });
  const sep = () => { if (T.length && T[T.length - 1].type !== 'separator') T.push({ type: 'separator' }); };

  if (params.misspelledWord) {
    for (const s of (params.dictionarySuggestions || []).slice(0, 5)) add(s, () => wc.replaceMisspelling(s));
    add('辞書に追加', () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord));
    sep();
  }
  if (params.linkURL) {
    add('リンクを新しいタブで開く', () => createTab(params.linkURL, { activate: false, afterActive: true }));
    add('リンクのアドレスをコピー', () => clipboard.writeText(params.linkURL));
    sep();
  }
  if (params.mediaType === 'image' && params.srcURL) {
    add('画像を新しいタブで開く', () => createTab(params.srcURL, { afterActive: true }));
    add('画像をコピー', () => wc.copyImageAt(params.x, params.y));
    add('画像のアドレスをコピー', () => clipboard.writeText(params.srcURL));
    add('画像を保存', () => wc.downloadURL(params.srcURL));
    sep();
  }
  const f = params.editFlags || {};
  if (params.isEditable) {
    add('元に戻す', () => wc.undo(), { enabled: f.canUndo });
    add('やり直す', () => wc.redo(), { enabled: f.canRedo });
    sep();
    add('切り取り', () => wc.cut(), { enabled: f.canCut });
    add('コピー', () => wc.copy(), { enabled: f.canCopy });
    add('貼り付け', () => wc.paste(), { enabled: f.canPaste });
    add('すべて選択', () => wc.selectAll(), { enabled: f.canSelectAll });
  } else if (params.selectionText) {
    add('コピー', () => wc.copy());
    const q = params.selectionText.trim();
    const label = q.length > 20 ? `${q.slice(0, 20)}…` : q;
    add(`「${label}」を検索`, () => createTab((SEARCH[settings.searchEngine] || SEARCH.google)[1] + encodeURIComponent(q), { afterActive: true }));
  }
  if (!params.isEditable && !params.selectionText && !params.linkURL && params.mediaType !== 'image') {
    add('戻る', () => wc.navigationHistory.goBack(), { enabled: wc.navigationHistory.canGoBack() });
    add('進む', () => wc.navigationHistory.goForward(), { enabled: wc.navigationHistory.canGoForward() });
    add('再読み込み', () => reloadActive(false));
    sep();
    add('印刷...', printPage);
    add('ページを保存...', savePage);
  }
  sep();
  add('検証', () => wc.inspectElement(params.x, params.y));
  while (T.length && T[T.length - 1].type === 'separator') T.pop();
  Menu.buildFromTemplate(T).popup({ window: win });
}

// ───────── セッション ─────────
function setupSession() {
  const ses = session.defaultSession;

  // ダウンロード
  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    const orig = (item.getFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_');
    const ext = path.extname(orig);
    const stem = path.basename(orig, ext);
    let p = path.join(dir, orig);
    for (let n = 1; fs.existsSync(p); n++) p = path.join(dir, `${stem} (${n})${ext}`);
    item.setSavePath(p);
    const rec = {
      id: uid(), name: path.basename(p), url: item.getURL(), path: p,
      total: item.getTotalBytes(), received: 0, state: 'progressing', time: Date.now(),
    };
    downloads.unshift(rec);
    if (downloads.length > 200) downloads.length = 200;
    downloadItems.set(rec.id, item);
    item.on('updated', (_ev, st) => {
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.state = st === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      broadcastInternal('downloads:changed');
    });
    item.once('done', (_ev, st) => {
      rec.received = item.getReceivedBytes();
      rec.state = st;
      downloadItems.delete(rec.id);
      save('downloads.json', downloads);
      broadcastInternal('downloads:changed');
      pushState();
    });
    pushState();
    broadcastInternal('downloads:changed');
  });

  // 権限（カメラ・位置情報など）
  const AUTO = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection']);
  const ASK = {
    media: 'カメラ・マイク', geolocation: '位置情報', notifications: '通知',
    'clipboard-read': 'クリップボードの読み取り', midi: 'MIDI機器',
  };
  const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO.has(permission)) return true;
    if (isInternal(requestingOrigin)) return false;
    return settings.permissions[`${requestingOrigin}|${permission}`] === true;
  });
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (AUTO.has(permission)) return callback(true);
    const label = ASK[permission];
    const origin = originOf(details.requestingUrl || wc.getURL());
    if (!label || !/^https?:/i.test(origin)) return callback(false);
    const key = `${origin}|${permission}`;
    if (key in settings.permissions) return callback(settings.permissions[key] === true);
    try {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        message: `${new URL(origin).host} が「${label}」の使用を求めています`,
        buttons: ['許可', 'ブロック'], defaultId: 1, cancelId: 1,
        checkboxLabel: 'この選択を記憶する',
      });
      const ok = r.response === 0;
      if (r.checkboxChecked) { settings.permissions[key] = ok; saveSettings(); }
      callback(ok);
    } catch { callback(false); }
  });
}

// セッションCookie（有効期限なし）を、終了後も残るように30日の期限付きにする
async function persistSessionCookies() {
  const ses = session.defaultSession;
  const all = await ses.cookies.get({});
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  for (const c of all) {
    if (!c.session) continue;
    try {
      const host = c.domain.replace(/^\./, '');
      await ses.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name, value: c.value,
        domain: c.hostOnly ? undefined : c.domain,
        path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite, expirationDate: exp,
      });
    } catch { /* 個別の失敗は無視 */ }
  }
  await ses.cookies.flushStore();
}

function registerProtocol() {
  protocol.handle(SCHEME, (req) => {
    const u = new URL(req.url);
    let file;
    if (u.hostname === 'assets') {
      const n = path.basename(u.pathname);
      if (!/^[\w.-]+\.(css|js|svg|png)$/.test(n)) return new Response('Not found', { status: 404 });
      file = path.join(__dirname, 'renderer', n);
    } else if (PAGES.has(u.hostname)) {
      file = path.join(__dirname, 'renderer', `${u.hostname}.html`);
    } else {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ───────── 初期設定ウィザード ─────────
function wizPayload() {
  if (!wiz) return null;
  return {
    step: wiz.step, idx: wiz.idx, total: PORTALS.length,
    portal: PORTALS[wiz.idx] ? PORTALS[wiz.idx].name : '',
    first: wiz.first, userName: settings.userName, usage: settings.usage, presets: PRESETS,
  };
}
function pushWiz() {
  if (wizView && alive(wizView.webContents)) wizView.webContents.send('wizard:state', wizPayload());
}
function loadPortal(i) {
  if (!portalView) {
    portalView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    portalView.webContents.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) portalView.webContents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
  }
  portalView.webContents.loadURL(PORTALS[i].url).catch(() => {});
}
function startWizard(step, first) {
  if (!wizView) wizView = makeShellView('wizard');
  closeFind(true);
  wiz = { step, idx: 0, first: !!first, timer: null };
  if (step === 'portal') loadPortal(0);
  pushWiz();
  render();
}
function finishWizard() {
  if (!wiz) return;
  clearTimeout(wiz.timer);
  wiz = null;
  if (portalView) portalView.webContents.loadURL('about:blank').catch(() => {});
  if (!settings.setupDone) settings.setupDone = true;
  saveSettings();
  if (!tabs.length) startBrowser();
  evalLock();
  render();
  pushState();
}

// ───────── ブラウザ起動 ─────────
function startBrowser() {
  if (settings.restoreTabs && Array.isArray(settings.tabs)) {
    for (const s of settings.tabs.slice(0, 30)) {
      if (s && isWeb(s.url)) createTab(s.url, { lazy: true, title: s.title || '', activate: false });
    }
  }
  // 前回のタブはそのまま残し、ホームは新しいタブで開く
  createTab(HOME_URL, { activate: true });
}

// ───────── 利用時間のロック ─────────
function lockInfo() { return { label: rangeLabel() }; }
function evalLock() {
  const should = !wiz && !!win && !isAllowedNow();
  if (should && !lockView) lockView = makeShellView('lock');
  if (should === locked) {
    if (locked && lockView) lockView.webContents.send('lock:info', lockInfo());
    return;
  }
  locked = should;
  if (locked) closeFind(true);
  for (const t of tabs) if (alive(t.wc)) t.wc.setAudioMuted(locked);
  if (locked && lockView) lockView.webContents.send('lock:info', lockInfo());
  render();
}

// ───────── 自動更新 ─────────
function setUpdateStatus(s) {
  updateStatus = s;
  broadcastInternal('update:status', s);
}
function setupUpdater() {
  if (!app.isPackaged) { updateStatus = '開発モードでは無効です'; return; }
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    updateStatus = '更新機能を読み込めませんでした';
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => setUpdateStatus('確認中…'));
  updater.on('update-available', (i) => setUpdateStatus(`新しいバージョン ${i.version} をダウンロード中…`));
  updater.on('update-not-available', () => setUpdateStatus(`最新です（${new Date().toLocaleString('ja-JP')} 確認）`));
  updater.on('download-progress', (p) => setUpdateStatus(`ダウンロード中… ${Math.round(p.percent)}%`));
  updater.on('error', (e) => { console.error('update error', e); setUpdateStatus('更新を確認できませんでした'); });
  updater.on('update-downloaded', async (i) => {
    setUpdateStatus(`バージョン ${i.version} の準備ができました`);
    try {
      const r = await dialog.showMessageBox(win, {
        type: 'info', message: '新しいバージョンをインストールできます',
        detail: '再起動すると更新が適用されます。「あとで」を選んでも、終了時に自動で更新されます。',
        buttons: ['今すぐ再起動', 'あとで'], defaultId: 0, cancelId: 1,
      });
      if (r.response === 0) {
        saveTabsNow();
        await persistSessionCookies().catch(() => {});
        flushAll();
        quitting = true;
        updater.quitAndInstall(false, true);
      }
    } catch { /* ダイアログ失敗時は終了時に更新 */ }
  });
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

// ───────── IPC ─────────
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    const f = e.senderFrame;
    if (!f || !f.url.startsWith(`${SCHEME}://`) || f !== e.sender.mainFrame) throw new Error('forbidden');
    return fn(e, ...args);
  });
}

// ───────── 暗証番号（PIN） ─────────
let unlockedUntil = 0, pinFails = 0, pinBlockedUntil = 0;
const UNLOCK_MS = 10 * 60 * 1000;
const pinSet = () => !!(settings.pin && settings.pin.hash);
const isUnlocked = () => !pinSet() || Date.now() < unlockedUntil;
const validPin = (p) => /^\d{4,8}$/.test(String(p || ''));
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  settings.pin = { salt, hash: hashPin(pin, salt) };
  saveSettings();
  unlockedUntil = Date.now() + UNLOCK_MS;
}
function guard() {
  if (!isUnlocked()) return false;
  if (pinSet()) unlockedUntil = Date.now() + UNLOCK_MS;
  return true;
}
function waitSec() { return Math.max(0, Math.ceil((pinBlockedUntil - Date.now()) / 1000)); }
function checkPin(pin) {
  if (waitSec() > 0) return { ok: false, wait: waitSec() };
  if (!pinSet()) return { ok: true };
  const a = Buffer.from(hashPin(String(pin || ''), settings.pin.salt), 'hex');
  const b = Buffer.from(settings.pin.hash, 'hex');
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    pinFails = 0;
    unlockedUntil = Date.now() + UNLOCK_MS;
    return { ok: true };
  }
  pinFails += 1;
  if (pinFails >= 5) pinBlockedUntil = Date.now() + 30000 * Math.min(pinFails - 4, 10);
  return { ok: false, wait: waitSec() };
}

function registerIpc() {
  // タブ・ナビゲーション
  handle('ui:ready', () => snapshot());
  handle('tabs:new', () => { createTab(HOME_URL); });
  handle('tabs:activate', (_e, id) => activateTab(id));
  handle('tabs:close', (_e, id) => closeTab(id));
  handle('tabs:reorder', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length !== tabs.length) return;
    const ordered = ids.map(tabById);
    if (ordered.some((t) => !t)) return;
    tabs = ordered;
    pushState();
    saveTabsSoon();
  });
  handle('tab:menu', (_e, id) => showTabMenu(id));
  handle('menu:main', (_e, p) => showMainMenu(p.x, p.y));
  handle('nav:go', (_e, text) => {
    const t = activeTab();
    const url = normalizeInput(text);
    if (!t || !url) return;
    t.errorUrl = null;
    t.pending = null;
    t.wc.loadURL(url).catch(() => {});
    t.wc.focus();
  });
  handle('nav:back', () => { const t = activeTab(); if (t && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack(); });
  handle('nav:forward', () => { const t = activeTab(); if (t && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward(); });
  handle('nav:reload', () => {
    const t = activeTab();
    if (!t) return;
    if (t.loading) t.wc.stop(); else reloadActive(false);
  });
  handle('nav:home', () => goHome());
  handle('bookmark:toggle', () => toggleBookmark());
  handle('downloads:open-page', () => openInternal('downloads'));
  handle('suggest', (_e, text) => {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return [];
    const seen = new Set();
    const out = [];
    for (const x of [...bookmarks, ...history.slice(0, 500)]) {
      if (seen.has(x.url)) continue;
      if (x.url.toLowerCase().includes(q) || (x.title || '').toLowerCase().includes(q)) {
        seen.add(x.url);
        out.push({ url: x.url, title: x.title });
        if (out.length >= 6) break;
      }
    }
    return out;
  });

  // ページ内検索
  handle('find:query', (_e, p) => {
    const t = activeTab();
    if (!t) return;
    if (!p.text) { t.wc.stopFindInPage('clearSelection'); findView.webContents.send('find:result', { active: 0, total: 0 }); return; }
    t.wc.findInPage(p.text, { forward: p.forward !== false, findNext: !!p.next });
  });
  handle('find:close', () => closeFind());

  // ホーム
  handle('home:get', () => ({ userName: settings.userName, favorites: settings.favorites }));
  handle('home:set', (_e, favs) => {
    if (!guard()) return { locked: true };
    if (!Array.isArray(favs) || favs.length > 30) return { ok: false };
    const clean = [];
    for (const f of favs) {
      if (!f || typeof f.title !== 'string' || typeof f.url !== 'string' || !isWeb(f.url)) return { ok: false };
      clean.push({ title: f.title.trim().slice(0, 40) || f.url, url: f.url });
    }
    settings.favorites = clean;
    saveSettings();
    return { ok: true };
  });
  handle('home:reset', () => {
    if (!guard()) return { locked: true };
    settings.favorites = DEFAULT_FAVORITES.map((f) => ({ ...f }));
    saveSettings();
    return { ok: true, favorites: settings.favorites };
  });

  // 履歴・ブックマーク
  handle('history:list', (_e, q) => {
    const s = String(q || '').trim().toLowerCase();
    const list = s ? history.filter((h) => h.url.toLowerCase().includes(s) || (h.title || '').toLowerCase().includes(s)) : history;
    return list.slice(0, 500);
  });
  handle('history:delete', (_e, id) => {
    const i = history.findIndex((h) => h.id === id);
    if (i >= 0) { history.splice(i, 1); save('history.json', history); }
  });
  handle('history:clear', () => { history.length = 0; save('history.json', history); });
  handle('bookmarks:list', () => bookmarks);
  handle('bookmarks:delete', (_e, id) => {
    const i = bookmarks.findIndex((b) => b.id === id);
    if (i >= 0) { bookmarks.splice(i, 1); save('bookmarks.json', bookmarks); pushState(); }
  });

  // ダウンロード
  handle('downloads:list', () => downloads);
  handle('downloads:open', (_e, id) => {
    const d = downloads.find((x) => x.id === id);
    if (d && d.state === 'completed') shell.openPath(d.path);
  });
  handle('downloads:show', (_e, id) => {
    const d = downloads.find((x) => x.id === id);
    if (d) shell.showItemInFolder(d.path);
  });
  handle('downloads:cancel', (_e, id) => { const it = downloadItems.get(id); if (it) it.cancel(); });
  handle('downloads:remove', (_e, id) => {
    const i = downloads.findIndex((x) => x.id === id);
    if (i >= 0 && !downloadItems.has(id)) { downloads.splice(i, 1); save('downloads.json', downloads); broadcastInternal('downloads:changed'); }
  });
  handle('downloads:clear', () => {
    for (let i = downloads.length - 1; i >= 0; i--) if (!downloadItems.has(downloads[i].id)) downloads.splice(i, 1);
    save('downloads.json', downloads);
    broadcastInternal('downloads:changed');
  });

  // 画面の操作（タブレット用）
  handle('win:fullscreen', () => toggleFullscreen());
  handle('chrome:hide', () => setHideBars(true));
  handle('chrome:show', () => setHideBars(false));

  // 暗証番号
  handle('pin:status', () => ({ set: pinSet(), unlocked: isUnlocked(), wait: waitSec() }));
  handle('pin:verify', (_e, pin) => checkPin(pin));
  handle('pin:lock', () => { unlockedUntil = 0; return true; });
  handle('pin:set', (_e, p) => {
    if (pinSet()) {
      const r = checkPin(p && p.current);
      if (!r.ok) return { ok: false, error: 'current', wait: r.wait };
    }
    if (!validPin(p && p.pin)) return { ok: false, error: 'format' };
    setPin(p.pin);
    return { ok: true };
  });
  handle('pin:remove', (_e, current) => {
    const r = checkPin(current);
    if (!r.ok) return { ok: false, error: 'current', wait: r.wait };
    settings.pin = null;
    saveSettings();
    return { ok: true };
  });

  // 設定
  handle('settings:get', () => {
    if (!isUnlocked()) return { locked: true };
    guard();
    return {
      userName: settings.userName, usage: settings.usage, presets: PRESETS,
      hideBars: settings.hideBars,
      restoreTabs: settings.restoreTabs, searchEngine: settings.searchEngine,
      engines: Object.fromEntries(Object.entries(SEARCH).map(([k, v]) => [k, v[0]])),
      version: app.getVersion(), updateStatus, packaged: app.isPackaged, pinSet: pinSet(),
    };
  });
  handle('settings:set', (_e, p) => {
    if (!guard()) return { locked: true };
    if (!p || typeof p !== 'object') return { ok: false };
    if ('userName' in p) {
      const n = String(p.userName).trim().slice(0, 40);
      if (n) settings.userName = n;
    }
    if ('usage' in p) {
      const u = validUsage(p.usage);
      if (!u) return { ok: false };
      settings.usage = u;
    }
    if ('hideBars' in p) settings.hideBars = !!p.hideBars;
    if ('restoreTabs' in p) settings.restoreTabs = !!p.restoreTabs;
    if ('searchEngine' in p && SEARCH[p.searchEngine]) settings.searchEngine = p.searchEngine;
    saveSettings();
    evalLock();
    render();
    pushState();
    return { ok: true };
  });
  handle('data:clear', async (_e, o) => {
    if (!guard()) return { locked: true };
    const ses = session.defaultSession;
    if (o.cookies) await ses.clearStorageData();
    if (o.cache) await ses.clearCache();
    if (o.history) { history.length = 0; save('history.json', history); }
    if (o.downloads) {
      for (let i = downloads.length - 1; i >= 0; i--) if (!downloadItems.has(downloads[i].id)) downloads.splice(i, 1);
      save('downloads.json', downloads);
    }
    pushState();
    return { ok: true };
  });
  handle('update:check', () => {
    if (!updater) return updateStatus;
    updater.checkForUpdates().catch(() => {});
    return updateStatus;
  });
  handle('wizard:open-portals', () => {
    if (!guard()) return { locked: true };
    startWizard('portal', false);
    return { ok: true };
  });

  // ウィザード
  handle('wizard:get', () => wizPayload());
  handle('wizard:name', (_e, name) => {
    if (!wiz || wiz.step !== 'name') return;
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return;
    settings.userName = n;
    saveSettings();
    wiz.step = 'usage';
    pushWiz();
  });
  handle('wizard:back', () => {
    if (wiz && wiz.step === 'usage') { wiz.step = 'name'; pushWiz(); }
  });
  handle('wizard:usage', (_e, u) => {
    if (!wiz || wiz.step !== 'usage') return { ok: false, error: 'usage' };
    const v = validUsage(u);
    if (!v) return { ok: false, error: 'usage' };
    const pin = String((u && u.pin) || '');
    if (pin && !validPin(pin)) return { ok: false, error: 'pin' };
    settings.usage = v;
    if (pin && !pinSet()) setPin(pin);
    saveSettings();
    wiz.step = 'portal';
    wiz.idx = 0;
    loadPortal(0);
    pushWiz();
    render();
    return { ok: true };
  });
  handle('wizard:next', () => {
    if (!wiz || wiz.step !== 'portal') return;
    if (wiz.idx < PORTALS.length - 1) {
      wiz.idx += 1;
      loadPortal(wiz.idx);
      pushWiz();
      return;
    }
    if (!wiz.first) { finishWizard(); return; }
    wiz.step = 'welcome';
    if (portalView) portalView.webContents.loadURL('about:blank').catch(() => {});
    pushWiz();
    render();
    wiz.timer = setTimeout(finishWizard, 5000);
  });
  handle('wizard:cancel', () => { if (wiz && !wiz.first) finishWizard(); });

  // ロック画面
  handle('lock:info', () => lockInfo());
}

// ───────── アプリのライフサイクル ─────────
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (quitting) { flushAll(); return; }
  e.preventDefault();
  quitting = true;
  saveTabsNow();
  saveWindowState();
  persistSessionCookies().catch(() => {}).finally(() => { flushAll(); app.quit(); });
});

app.whenReady().then(() => {
  loadData();
  Menu.setApplicationMenu(null);
  registerProtocol();
  setupSession();
  createWindow();
  registerIpc();
  if (!settings.setupDone) startWizard('name', true);
  else startBrowser();
  evalLock();
  setInterval(evalLock, 5000);
  setInterval(() => persistSessionCookies().catch(() => {}), 5 * 60 * 1000);
  setupUpdater();
});
