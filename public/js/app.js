// app.js — Main controller for Session Dashboard

// State
let selectedProject = null;
let selectedSession = null;
let sessionMeta = null;
let messages = [];
let offset = 0;
const PAGE_SIZE = 50;
let projectList = [];
let sessionList = [];
let totalMessages = 0;
let isLoading = false;
let hasMoreOlder = false;
let transientMessages = [];
let draftSessions = [];
let dashboardCapabilities = null;

function getDashboardSelection() {
  return {
    project: selectedProject,
    session: selectedSession,
    sessionMeta,
  };
}

function notifySessionSelection() {
  document.dispatchEvent(new CustomEvent('session:selected', {
    detail: getDashboardSelection(),
  }));
}

function currentMessageList() {
  return [...messages, ...transientMessages];
}

function displayedSessionList() {
  return [...draftSessions, ...sessionList];
}

function findSessionMetaById(id) {
  return displayedSessionList().find((session) => session.sessionId === id) || null;
}

function renderCurrentChat() {
  renderMessages(currentMessageList(), false);
  renderLoadMoreButton(hasMoreOlder);
}

function scrollChatToBottom() {
  const chatContainer = document.getElementById('chat-messages');
  if (!chatContainer) return;
  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

function setTransientMessages(nextMessages) {
  transientMessages = Array.isArray(nextMessages) ? nextMessages.slice() : [];
  renderCurrentChat();
  scrollChatToBottom();
}

function clearTransientMessages() {
  transientMessages = [];
  renderCurrentChat();
  scrollChatToBottom();
}

window.__dashboardSetTransientMessages = setTransientMessages;
window.__dashboardClearTransientMessages = clearTransientMessages;

async function reloadCurrentSession() {
  if (!selectedProject || !selectedSession) return;
  offset = 0;
  messages = [];
  transientMessages = [];
  await loadMessages(selectedProject, selectedSession, false);
}

async function reloadSessionsAndSelect(projectDir, matcher) {
  await loadSessions(projectDir, matcher || null);
}

window.__dashboardGetSelection = getDashboardSelection;
window.reloadCurrentSession = reloadCurrentSession;
window.__dashboardReloadSessionsAndSelect = reloadSessionsAndSelect;

// ==================== HTML Escaping ====================
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== API Calls ====================
async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`API error: ${url}`, err);
    return null;
  }
}

async function createDraftSession(projectDir, source) {
  try {
    const res = await fetch(`/api/draft-session/${encodeURIComponent(projectDir)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('Draft session error', err);
    return null;
  }
}

function renderSessionActions() {
  const container = document.getElementById('session-actions');
  if (!container) return;

  if (!selectedProject || !dashboardCapabilities) {
    container.innerHTML = '';
    return;
  }

  const specs = [
    { source: 'codex', label: 'New CX' },
    { source: 'claude', label: 'New CC' },
    { source: 'copilot', label: 'New CP' },
  ];

  container.innerHTML = specs.map(({ source, label }) => {
    const capability = dashboardCapabilities[source];
    const disabled = !capability || !capability.enabled;
    return `
      <button
        class="session-action-btn source-${escapeHtml(source)}"
        data-source="${escapeHtml(source)}"
        title="${escapeHtml(capability ? capability.note : '')}"
        ${disabled ? 'disabled' : ''}
      >${escapeHtml(label)}</button>
    `;
  }).join('');

  container.querySelectorAll('.session-action-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const source = button.dataset.source;
      const draft = await createDraftSession(selectedProject, source);
      if (!draft) return;

      draftSessions = draftSessions.filter((session) => session.source !== source);
      draftSessions.unshift(draft);
      renderSessionList(displayedSessionList(), selectedSession);
      selectSessionById(draft.sessionId, { skipFetch: true });
    });
  });
}

function selectSessionById(sessionId, options = {}) {
  const meta = findSessionMetaById(sessionId);
  if (!meta) return;

  selectedSession = sessionId;
  sessionMeta = meta;
  renderSessionList(displayedSessionList(), selectedSession);
  renderChatHeader(sessionMeta);
  notifySessionSelection();

  if (meta.isDraft) {
    messages = [];
    transientMessages = [];
    hasMoreOlder = false;
    totalMessages = 0;
    document.getElementById('chat-messages').innerHTML = '<div class="empty-state">New session ready. Send a message to create it.</div>';
    return;
  }

  if (!options.skipFetch) {
    loadMessages(selectedProject, sessionId, false);
  }
}

async function loadProjects() {
  updateStatus('Loading projects...');
  const data = await fetchJSON('/api/projects');
  if (!data) {
    document.getElementById('project-list').innerHTML = '<div class="empty-state">Failed to load projects</div>';
    return;
  }
  projectList = data;
  renderProjectList(projectList, selectedProject);
  updateStatusBar();
}

async function loadSessions(projectDir, matcher = null) {
  selectedProject = projectDir;
  selectedSession = null;
  sessionMeta = null;
  messages = [];
  offset = 0;
  hasMoreOlder = false;
  draftSessions = [];

  renderProjectList(projectList, selectedProject);
  renderChatHeader(null);
  document.getElementById('chat-messages').innerHTML = '<div class="empty-state">Select a session to view conversation</div>';
  transientMessages = [];
  notifySessionSelection();
  renderSessionActions();

  const container = document.getElementById('session-list');
  container.innerHTML = '<div class="loading">Loading sessions...</div>';

  const data = await fetchJSON(`/api/sessions/${encodeURIComponent(projectDir)}`);
  if (!data) {
    container.innerHTML = '<div class="empty-state">Failed to load sessions</div>';
    return;
  }

  sessionList = data;
  renderSessionList(displayedSessionList(), selectedSession);
  updateStatusBar();

  if (matcher) {
    const matched = sessionList.find((session) => (
      (!matcher.source || session.source === matcher.source) &&
      (!matcher.rawSessionId || session.rawSessionId === matcher.rawSessionId)
    ));
    if (matched) {
      selectSessionById(matched.sessionId);
    }
  }
}

async function loadMessages(projectDir, sessionId, loadOlder) {
  if (isLoading) return;
  isLoading = true;

  if (!loadOlder) {
    // Fresh load — get latest messages
    selectedSession = sessionId;
    offset = 0;
    messages = [];
    document.getElementById('chat-messages').innerHTML = '<div class="loading">Loading messages...</div>';

    sessionMeta = findSessionMetaById(sessionId);
    renderSessionList(displayedSessionList(), selectedSession);
    renderChatHeader(sessionMeta);
    notifySessionSelection();
  }

  // direction=newest: offset=0 gets the last PAGE_SIZE messages
  const url = `/api/messages/${encodeURIComponent(projectDir)}/${encodeURIComponent(sessionId)}?offset=${offset}&limit=${PAGE_SIZE}&direction=newest`;
  const data = await fetchJSON(url);

  isLoading = false;

  if (!data) {
    if (!loadOlder) {
      document.getElementById('chat-messages').innerHTML = '<div class="empty-state">Failed to load messages</div>';
    }
    return;
  }

  totalMessages = data.total || 0;
  hasMoreOlder = data.hasMore;

  if (loadOlder) {
    // Prepend older messages
    messages = [...data.messages, ...messages];
    const chatContainer = document.getElementById('chat-messages');
    const prevScrollHeight = chatContainer.scrollHeight;
    renderCurrentChat();
    // Maintain scroll position after prepending
    chatContainer.scrollTop = chatContainer.scrollHeight - prevScrollHeight;
  } else {
    messages = data.messages || [];
    renderCurrentChat();
    scrollChatToBottom();
  }

  // Update model info in header from first assistant message
  if (sessionMeta && !sessionMeta.model) {
    const assistantMsg = (data.messages || []).find(m => m.model);
    if (assistantMsg) {
      sessionMeta.model = assistantMsg.model;
      renderChatHeader(sessionMeta);
    }
  }

  offset += (data.messages || []).length;
}

function loadMoreMessages() {
  if (selectedProject && selectedSession) {
    loadMessages(selectedProject, selectedSession, true);
  }
}

// ==================== Status Bar ====================
function updateStatusBar() {
  const projectCount = projectList.length;
  const sessionCount = projectList.reduce((sum, p) => sum + (p.sessionCount || 0), 0);
  const sourceSet = new Set();
  projectList.forEach((project) => {
    (project.sources || []).forEach((source) => sourceSet.add(source));
  });
  document.getElementById('status-info').textContent =
    `${projectCount} projects | ${sessionCount} sessions | ${sourceSet.size} tools`;
}

function updateStatus(text) {
  const el = document.getElementById('status-info');
  if (el) el.textContent = text;
}

// ==================== Init ====================
document.addEventListener('DOMContentLoaded', () => {
  fetchJSON('/api/capabilities').then((data) => {
    dashboardCapabilities = data;
    renderSessionActions();
  });

  // Wire up project selection
  onProjectSelect((dir) => {
    loadSessions(dir);
  });

  // Wire up session selection
  onSessionSelect((id) => {
    selectSessionById(id);
  });

  // Load projects on start
  loadProjects();
});
