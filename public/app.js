// ==================== STATE ====================
const state = {
  token: null,
  labs: [],
  expandedLabs: new Set(),
  labNodes: {},         // labId → nodes[]
  loadingNodes: new Set(),
  tabs: new Map(),      // tabId → TabData
  activeTabId: null,
};

// ==================== DOM ====================
const $ = (id) => document.getElementById(id);

// ==================== API ====================
async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ==================== AUTH ====================
async function handleLogin(e) {
  e.preventDefault();
  const username = $('username').value.trim();
  const password = $('password').value;
  const errEl = $('login-error');
  const btn = $('login-btn');

  errEl.textContent = '';
  btn.disabled = true;
  $('login-btn-text').textContent = 'Connecting…';
  $('login-spinner').classList.remove('hidden');

  try {
    const { token } = await apiFetch('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.token = token;
    showApp();
    loadLabs();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    $('login-btn-text').textContent = 'Connect';
    $('login-spinner').classList.add('hidden');
  }
}

function handleLogout() {
  // Close all tabs silently
  for (const tabId of [...state.tabs.keys()]) closeTab(tabId, true);
  state.token = null;
  state.labs = [];
  state.expandedLabs.clear();
  state.labNodes = {};
  state.activeTabId = null;
  showLogin();
}

// ==================== LABS ====================
async function loadLabs() {
  const tree = $('labs-tree');
  tree.innerHTML = '<div class="empty-state"><span class="spinner"></span>Loading labs…</div>';
  setStatus('Loading labs…');

  try {
    const labs = await apiFetch('/api/labs');
    state.labs = labs;
    $('lab-count').textContent = labs.length;
    renderLabsTree();
    setStatus(`${labs.length} lab${labs.length !== 1 ? 's' : ''} loaded`);
  } catch (err) {
    tree.innerHTML = `<div class="error-item">⚠ ${escHtml(err.message)}</div>`;
    setStatus('Failed to load labs', 'error');
  }
}

async function loadNodes(labId) {
  if (state.loadingNodes.has(labId) || state.labNodes[labId]) return;
  state.loadingNodes.add(labId);
  renderLabsTree();

  try {
    const nodes = await apiFetch(`/api/labs/${labId}/nodes`);
    state.labNodes[labId] = nodes;
  } catch (err) {
    state.labNodes[labId] = [];
    console.error('Failed to load nodes:', err);
  } finally {
    state.loadingNodes.delete(labId);
    renderLabsTree();
  }
}

function toggleLab(labId) {
  if (state.expandedLabs.has(labId)) {
    state.expandedLabs.delete(labId);
    renderLabsTree();
  } else {
    state.expandedLabs.add(labId);
    if (!state.labNodes[labId]) {
      loadNodes(labId);
    } else {
      renderLabsTree();
    }
  }
}

// ==================== RENDER TREE ====================
function renderLabsTree() {
  const tree = $('labs-tree');
  if (!state.labs.length) {
    tree.innerHTML = '<div class="no-items">No labs found</div>';
    return;
  }

  tree.innerHTML = state.labs.map(renderLabItem).join('');

  tree.querySelectorAll('.lab-header[data-lab-id]').forEach((el) => {
    el.addEventListener('click', () => toggleLab(el.dataset.labId));
  });

  tree.querySelectorAll('.node-item.connectable').forEach((el) => {
    el.addEventListener('click', () =>
      openConsole(el.dataset.labId, el.dataset.nodeId, el.dataset.label, el.dataset.type)
    );
  });
}

function renderLabItem(lab) {
  const expanded = state.expandedLabs.has(lab.id);
  const sc = labStateClass(lab.state);

  let nodesHtml = '';
  if (expanded) {
    if (state.loadingNodes.has(lab.id)) {
      nodesHtml = '<div class="node-loading"><span class="spinner-sm"></span>Loading nodes…</div>';
    } else if (state.labNodes[lab.id]) {
      const nodes = state.labNodes[lab.id];
      nodesHtml = nodes.length
        ? nodes.map((n) => renderNodeItem(lab.id, n)).join('')
        : '<div class="no-items indent">No nodes</div>';
    }
  }

  return `
    <div class="lab-item">
      <div class="lab-header" data-lab-id="${lab.id}">
        <span class="chevron">${expanded ? '▾' : '▸'}</span>
        <span class="lab-state-dot ${sc}"></span>
        <span class="lab-title" title="${escHtml(lab.title || lab.id)}">${escHtml(lab.title || lab.id)}</span>
        <span class="state-badge ${sc}">${escHtml(lab.state || 'UNKNOWN')}</span>
      </div>
      ${expanded ? `<div class="nodes-list">${nodesHtml}</div>` : ''}
    </div>`;
}

function renderNodeItem(labId, node) {
  const sc = nodeStateClass(node.state);
  const canConnect = node.state === 'BOOTED';
  const hasSession = isConsoleOpen(labId, node.id);
  const defn = (node.node_definition || '').replace('cisco_', '').replace('_', '-');

  return `
    <div class="node-item ${canConnect ? 'connectable' : 'disabled'} ${hasSession ? 'active-session' : ''}"
      data-lab-id="${labId}"
      data-node-id="${node.id}"
      data-label="${escHtml(node.label || node.id)}"
      data-type="${escHtml(node.node_definition || '')}">
      <span class="node-state-dot ${sc}"></span>
      <span class="node-label" title="${escHtml(node.label || node.id)}">${escHtml(node.label || node.id)}</span>
      ${defn ? `<span class="node-type" title="${escHtml(node.node_definition)}">${escHtml(defn)}</span>` : ''}
      ${canConnect ? '<span class="connect-icon" title="Open console">⤠</span>' : ''}
    </div>`;
}

function labStateClass(s) {
  return s === 'STARTED' ? 'state-running' : s === 'STOPPED' ? 'state-stopped' : 'state-defined';
}

function nodeStateClass(s) {
  return s === 'BOOTED' ? 'state-booted' : s === 'STARTED' ? 'state-running' : s === 'STOPPED' ? 'state-stopped' : 'state-defined';
}

function isConsoleOpen(labId, nodeId) {
  for (const tab of state.tabs.values()) {
    if (tab.labId === labId && tab.nodeId === nodeId) return true;
  }
  return false;
}

// ==================== CONSOLE ====================
function openConsole(labId, nodeId, label, nodeType) {
  // Bring existing tab to front if already open
  for (const [tabId, tab] of state.tabs) {
    if (tab.labId === labId && tab.nodeId === nodeId) {
      switchToTab(tabId);
      return;
    }
  }
  const tabId = `${labId}__${nodeId}`;
  createConsoleTab(tabId, labId, nodeId, label);
}

function createConsoleTab(tabId, labId, nodeId, label) {
  // Terminal container
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.id = `pane-${tabId}`;
  pane.style.display = 'none';
  $('terminals').appendChild(pane);

  // xterm.js terminal
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 5000,
    theme: {
      background:      '#0d1117',
      foreground:      '#e6edf3',
      cursor:          '#58a6ff',
      cursorAccent:    '#0d1117',
      selectionBackground: 'rgba(88,166,255,0.25)',
      black:           '#484f58',
      red:             '#ff7b72',
      green:           '#3fb950',
      yellow:          '#d29922',
      blue:            '#58a6ff',
      magenta:         '#d2a8ff',
      cyan:            '#39c5cf',
      white:           '#b1bac4',
      brightBlack:     '#6e7681',
      brightRed:       '#ffa198',
      brightGreen:     '#56d364',
      brightYellow:    '#e3b341',
      brightBlue:      '#79c0ff',
      brightMagenta:   '#e9d9ff',
      brightCyan:      '#56d4dd',
      brightWhite:     '#f0f6fc',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(pane);

  // Tab data
  const tabData = { labId, nodeId, label, term, fitAddon, pane, ws: null, status: 'connecting' };
  state.tabs.set(tabId, tabData);

  term.write(`\x1b[2;37mConnecting to \x1b[0;36m${label}\x1b[2;37m console…\x1b[0m\r\n`);

  // Connect WebSocket
  connectWs(tabId);

  // User input → WS
  term.onData((data) => {
    const tab = state.tabs.get(tabId);
    if (tab?.ws?.readyState === WebSocket.OPEN) tab.ws.send(data);
  });

  renderTabs();
  switchToTab(tabId);
  renderLabsTree();
  updateSessionCount();
}

function connectWs(tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;

  const { labId, nodeId } = tab;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/console?lab=${encodeURIComponent(labId)}&node=${encodeURIComponent(nodeId)}&token=${encodeURIComponent(state.token)}&line=0`;

  const ws = new WebSocket(wsUrl);
  tab.ws = ws;
  tab.status = 'connecting';
  renderTabs();

  ws.onopen = () => {
    tab.status = 'connected';
    tab.term.write('\x1b[2;32mConnected — press Enter to begin.\x1b[0m\r\n\r\n');
    renderTabs();
    updateSessionCount();
    setStatus(`Console open: ${tab.label}`);
  };

  ws.onmessage = ({ data }) => {
    if (typeof data === 'string') {
      tab.term.write(data);
    } else if (data instanceof Blob) {
      data.arrayBuffer().then((buf) => tab.term.write(new Uint8Array(buf)));
    } else if (data instanceof ArrayBuffer) {
      tab.term.write(new Uint8Array(data));
    }
  };

  ws.onclose = (ev) => {
    if (!state.tabs.has(tabId)) return;
    tab.status = 'disconnected';
    tab.term.write(`\r\n\x1b[2;31m[Disconnected${ev.reason ? ': ' + ev.reason : ''}]\x1b[0m\r\n`);
    tab.term.write('\x1b[2;37mPress \x1b[0mCtrl+R\x1b[2;37m to reconnect.\x1b[0m\r\n');
    renderTabs();
    updateSessionCount();
  };

  ws.onerror = () => {
    if (!state.tabs.has(tabId)) return;
    tab.status = 'error';
    tab.term.write('\r\n\x1b[1;31m[Connection error — check CML2 and node state]\x1b[0m\r\n');
    renderTabs();
  };

  // Ctrl+R to reconnect
  tab.term.onKey(({ key, domEvent }) => {
    if (domEvent.ctrlKey && domEvent.key === 'r' && tab.status === 'disconnected') {
      tab.term.write('\r\n\x1b[2;37mReconnecting…\x1b[0m\r\n');
      connectWs(tabId);
    }
  });
}

// ==================== TABS ====================
function switchToTab(tabId) {
  if (state.activeTabId && state.tabs.has(state.activeTabId)) {
    state.tabs.get(state.activeTabId).pane.style.display = 'none';
  }

  state.activeTabId = tabId;
  const tab = state.tabs.get(tabId);

  if (tab) {
    $('welcome-screen').style.display = 'none';
    tab.pane.style.display = 'flex';
    requestAnimationFrame(() => {
      tab.fitAddon.fit();
      tab.term.focus();
    });
  }
  renderTabs();
}

function closeTab(tabId, silent = false) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;

  if (tab.ws && tab.ws.readyState < 2) tab.ws.close();
  tab.term.dispose();
  tab.pane.remove();
  state.tabs.delete(tabId);

  if (state.activeTabId === tabId) {
    state.activeTabId = null;
    const remaining = [...state.tabs.keys()];
    if (remaining.length) {
      switchToTab(remaining[remaining.length - 1]);
    } else {
      $('welcome-screen').style.display = 'flex';
    }
  }

  if (!silent) {
    renderTabs();
    renderLabsTree();
    updateSessionCount();
  }
}

function renderTabs() {
  const bar = $('tab-bar');
  const empty = $('tab-bar-empty');

  if (!state.tabs.size) {
    bar.innerHTML = '';
    bar.appendChild(empty);
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  const html = [...state.tabs.entries()].map(([tabId, tab]) => {
    const active = tabId === state.activeTabId;
    const dotClass =
      tab.status === 'connected'    ? 'state-booted'  :
      tab.status === 'disconnected' ? 'state-stopped' : 'state-running';
    return `
      <div class="tab${active ? ' active' : ''}" data-tab-id="${tabId}">
        <span class="tab-dot ${dotClass}"></span>
        <span class="tab-label" title="${escHtml(tab.label)}">${escHtml(tab.label)}</span>
        <button class="tab-close" data-tab-id="${tabId}" title="Close">×</button>
      </div>`;
  }).join('');

  bar.innerHTML = html;
  bar.appendChild(empty);

  bar.querySelectorAll('.tab').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (!ev.target.classList.contains('tab-close')) switchToTab(el.dataset.tabId);
    });
  });
  bar.querySelectorAll('.tab-close').forEach((el) => {
    el.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(el.dataset.tabId); });
  });
}

// ==================== UI HELPERS ====================
function showApp() {
  $('login-overlay').style.display = 'none';
  $('app').classList.remove('hidden');
}

function showLogin() {
  $('login-overlay').style.display = 'flex';
  $('app').classList.add('hidden');
  $('labs-tree').innerHTML = '';
  $('lab-count').textContent = '0';
  $('login-error').textContent = '';
}

function setStatus(msg, type = 'info') {
  const el = $('status-text');
  el.textContent = msg;
  el.className = type === 'error' ? 'status-text status-error' : 'status-text';
}

function updateSessionCount() {
  let n = 0;
  for (const tab of state.tabs.values()) if (tab.status === 'connected') n++;
  $('active-sessions').textContent = `${n} active session${n !== 1 ? 's' : ''}`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== INIT ====================
async function init() {
  $('login-form').addEventListener('submit', handleLogin);
  $('logout-btn').addEventListener('click', handleLogout);
  $('refresh-btn').addEventListener('click', loadLabs);

  window.addEventListener('resize', () => {
    if (state.activeTabId) {
      const tab = state.tabs.get(state.activeTabId);
      if (tab?.fitAddon) requestAnimationFrame(() => tab.fitAddon.fit());
    }
  });

  try {
    const { cmlHost } = await apiFetch('/api/config');
    $('login-host').textContent = cmlHost;
    $('host-badge').textContent = cmlHost;
  } catch (_) {}

  renderTabs();
}

document.addEventListener('DOMContentLoaded', init);
