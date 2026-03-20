// app.js — Main controller for Session Dashboard

// State
let selectedProject = null;
let selectedSession = null;
let sessionMeta = null;
let messages = [];
let offset = 0;
const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 4000;
const DASHBOARD_STATE_KEY = 'session-dashboard-state-v1';
const DASHBOARD_DRAFTS_KEY = 'session-dashboard-drafts-v1';
let projectList = [];
let sessionList = [];
let totalMessages = 0;
let isLoading = false;
let hasMoreOlder = false;
const transientMessagesBySession = new Map();
let draftSessions = [];
let dashboardCapabilities = null;
let pollInFlight = false;
let initialRestoreAttempted = false;
const sessionsNeedingHydration = new Set();
const activeInteractionSessions = new Set();
const activeProjectBySession = new Map();
const sessionStateCacheBySession = new Map();
const sessionScrollModeBySession = new Map();
const AUTO_FOLLOW_BOTTOM_THRESHOLD = 48;

function safeReadStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage write failures.
  }
}

function persistDraftSessions() {
  safeWriteStorage(DASHBOARD_DRAFTS_KEY, draftSessions);
}

function loadPersistedDraftSessions() {
  const stored = safeReadStorage(DASHBOARD_DRAFTS_KEY, []);
  return Array.isArray(stored) ? stored : [];
}

function persistDashboardState() {
  safeWriteStorage(DASHBOARD_STATE_KEY, {
    project: selectedProject,
    session: selectedSession,
    source: sessionMeta?.source || '',
    rawSessionId: sessionMeta?.rawSessionId || '',
  });
}

function loadPersistedDashboardState() {
  return safeReadStorage(DASHBOARD_STATE_KEY, null);
}

function currentDraftSessions(projectDir = selectedProject) {
  if (!projectDir) return [];
  return draftSessions.filter((session) => session.projectDir === projectDir);
}

function defaultSessionForProject(projectDir = selectedProject) {
  if (sessionList.length > 0) return sessionList[0];
  const drafts = currentDraftSessions(projectDir);
  return drafts[0] || null;
}

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
  return [...messages, ...(transientMessagesBySession.get(selectedSession) || [])];
}

function displayedSessionList() {
  return [...currentDraftSessions(), ...sessionList];
}

function activeProjectIds() {
  return new Set(activeProjectBySession.values());
}

function renderProjectSidebar() {
  renderProjectList(projectList, selectedProject, activeProjectIds());
}

function renderDisplayedSessionList() {
  renderSessionList(displayedSessionList(), selectedSession, activeInteractionSessions);
}

function findSessionMetaById(id) {
  return displayedSessionList().find((session) => session.sessionId === id) || null;
}

function currentSessionHasTransientActivity() {
  return !!(selectedSession && (transientMessagesBySession.get(selectedSession) || []).length);
}

function renderCurrentChat() {
  renderMessages(currentMessageList(), false);
  renderLoadMoreButton(hasMoreOlder);
}

function chatContainer() {
  return document.getElementById('chat-messages');
}

function isChatNearBottom(container = chatContainer()) {
  if (!container) return true;
  const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
  return remaining <= AUTO_FOLLOW_BOTTOM_THRESHOLD;
}

function setSessionAutoFollow(sessionId, shouldFollow) {
  if (!sessionId) return;
  sessionScrollModeBySession.set(sessionId, !!shouldFollow);
}

function shouldAutoFollowSession(sessionId = selectedSession) {
  if (!sessionId) return true;
  return sessionScrollModeBySession.get(sessionId) !== false;
}

function cacheSessionState(sessionId = selectedSession, meta = sessionMeta) {
  if (!sessionId || meta?.isDraft) return;
  sessionStateCacheBySession.set(sessionId, {
    messages: messages.slice(),
    offset,
    totalMessages,
    hasMoreOlder,
  });
}

function restoreCachedSessionState(sessionId) {
  const cached = sessionStateCacheBySession.get(sessionId);
  if (!cached) return false;
  messages = cached.messages.slice();
  offset = cached.offset;
  totalMessages = cached.totalMessages;
  hasMoreOlder = cached.hasMoreOlder;
  renderCurrentChat();
  if (shouldAutoFollowSession(sessionId)) {
    scrollChatToBottom();
  }
  return true;
}

function scrollChatToBottom() {
  const chatContainer = document.getElementById('chat-messages');
  if (!chatContainer) return;
  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

function setTransientMessagesForSession(sessionId, nextMessages) {
  if (!sessionId) return;
  const followBeforeRender = sessionId === selectedSession
    ? (shouldAutoFollowSession(sessionId) || isChatNearBottom())
    : shouldAutoFollowSession(sessionId);
  setSessionAutoFollow(sessionId, followBeforeRender);
  const normalized = Array.isArray(nextMessages) ? nextMessages.slice() : [];
  if (normalized.length > 0) {
    transientMessagesBySession.set(sessionId, normalized);
  } else {
    transientMessagesBySession.delete(sessionId);
  }
  renderCurrentChat();
  if (followBeforeRender) {
    scrollChatToBottom();
  }
}

function clearTransientMessagesForSession(sessionId) {
  if (!sessionId) return;
  const followBeforeRender = sessionId === selectedSession
    ? (shouldAutoFollowSession(sessionId) || isChatNearBottom())
    : shouldAutoFollowSession(sessionId);
  setSessionAutoFollow(sessionId, followBeforeRender);
  transientMessagesBySession.delete(sessionId);
  renderCurrentChat();
  if (followBeforeRender) {
    scrollChatToBottom();
  }
}

window.__dashboardSetTransientMessagesForSession = setTransientMessagesForSession;
window.__dashboardClearTransientMessagesForSession = clearTransientMessagesForSession;
window.__dashboardSetSessionActivityState = (sessionId, active, projectToken = '') => {
  if (!sessionId) return;
  if (active) {
    activeInteractionSessions.add(sessionId);
    if (projectToken) {
      activeProjectBySession.set(sessionId, projectToken);
    }
  } else {
    activeInteractionSessions.delete(sessionId);
    activeProjectBySession.delete(sessionId);
  }
  renderDisplayedSessionList();
  renderProjectSidebar();
};

async function reloadCurrentSession() {
  if (!selectedProject || !selectedSession) return;
  offset = 0;
  messages = [];
  transientMessagesBySession.delete(selectedSession);
  sessionsNeedingHydration.delete(selectedSession);
  sessionStateCacheBySession.delete(selectedSession);
  setSessionAutoFollow(selectedSession, true);
  await loadMessages(selectedProject, selectedSession, false);
}

async function reloadSessionsAndSelect(projectDir, matcher) {
  await loadSessions(projectDir, matcher || null);
}

async function refreshCurrentProjectSessionsSilently() {
  if (!selectedProject) return;
  const data = await fetchJSON(`/api/sessions/${encodeURIComponent(selectedProject)}`);
  if (!data) return;

  const previousSelected = selectedSession;
  sessionList = data;
  reconcileDraftSessionsForProject(selectedProject, sessionList);
  renderDisplayedSessionList();

  if (previousSelected) {
    const nextMeta = findSessionMetaById(previousSelected);
    if (nextMeta) {
      sessionMeta = nextMeta;
      renderChatHeader(sessionMeta);
      persistDashboardState();
    }
  }
}

function matchSessionByMatcher(items, matcher) {
  if (!matcher) return null;

  if (matcher.sessionId) {
    const exact = items.find((session) => session.sessionId === matcher.sessionId);
    if (exact) return exact;
  }

  if (matcher.source || matcher.rawSessionId) {
    const bySource = items.find((session) => (
      (!matcher.source || session.source === matcher.source) &&
      (!matcher.rawSessionId || session.rawSessionId === matcher.rawSessionId)
    ));
    if (bySource) return bySource;
  }

  return null;
}

function reconcileDraftSessionsForProject(projectDir, sessions) {
  const before = draftSessions.length;
  draftSessions = draftSessions.filter((draft) => {
    if (draft.projectDir !== projectDir) return true;
    if (!draft.rawSessionId) return true;
    return !sessions.some((session) => (
      session.source === draft.source &&
      session.rawSessionId &&
      session.rawSessionId === draft.rawSessionId
    ));
  });

  if (draftSessions.length !== before) {
    persistDraftSessions();
  }
}

function upsertDraftSession(draft) {
  draftSessions = draftSessions.filter((session) => (
    !(session.projectDir === draft.projectDir && session.source === draft.source)
  ));
  draftSessions.unshift(draft);
  persistDraftSessions();
}

function rememberCreatedSessionForDraft(draftSessionId, createdSession) {
  if (!draftSessionId || !createdSession?.rawSessionId) return;

  let updated = false;
  draftSessions = draftSessions.map((draft) => {
    if (draft.sessionId !== draftSessionId) return draft;
    updated = true;
    return {
      ...draft,
      rawSessionId: createdSession.rawSessionId,
      summary: 'Session created. Waiting for history to appear...',
      modified: new Date().toISOString(),
    };
  });

  if (updated) {
    persistDraftSessions();
    if (selectedSession === draftSessionId) {
      sessionMeta = findSessionMetaById(draftSessionId) || sessionMeta;
      persistDashboardState();
    }
  }
}

async function restoreInitialDashboardView() {
  if (initialRestoreAttempted) return;
  initialRestoreAttempted = true;

  draftSessions = loadPersistedDraftSessions();
  const saved = loadPersistedDashboardState();
  if (!saved?.project) return false;

  const projectExists = projectList.some((project) => project.dirName === saved.project);
  if (!projectExists) return false;

  await loadSessions(saved.project, {
    sessionId: saved.session || '',
    source: saved.source || '',
    rawSessionId: saved.rawSessionId || '',
  });
  return true;
}

window.__dashboardGetSelection = getDashboardSelection;
window.reloadCurrentSession = reloadCurrentSession;
window.__dashboardReloadSessionsAndSelect = reloadSessionsAndSelect;
window.__dashboardRememberCreatedSessionForDraft = rememberCreatedSessionForDraft;
window.__dashboardMarkSessionNeedsHydration = (sessionId) => {
  if (sessionId) sessionsNeedingHydration.add(sessionId);
};
window.__dashboardFinalizeInteractionHydration = async ({ projectToken, sessionId, createdSession } = {}) => {
  if (!sessionId) return;

  sessionsNeedingHydration.delete(sessionId);

  if (selectedProject === projectToken && selectedSession === sessionId) {
    if (createdSession && typeof reloadSessionsAndSelect === 'function') {
      await reloadSessionsAndSelect(projectToken, createdSession);
      return;
    }
    await reloadCurrentSession();
    return;
  }

  clearTransientMessagesForSession(sessionId);

  if (selectedProject === projectToken) {
    await refreshCurrentProjectSessionsSilently();
  }
};

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
    const draft = await res.json();
    return {
      ...draft,
      projectDir,
    };
  } catch (err) {
    console.error('Draft session error', err);
    return null;
  }
}

async function deleteSessionRequest(projectDir, sessionId) {
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(projectDir)}/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('Delete session error', err);
    return null;
  }
}

async function renameSessionRequest(projectDir, sessionId, title) {
  try {
    const res = await fetch(`/api/session-title/${encodeURIComponent(projectDir)}/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('Rename session error', err);
    return null;
  }
}

async function fetchLatestMessagesForTransfer(projectDir, sessionId, limit = 16) {
  const url = `/api/messages/${encodeURIComponent(projectDir)}/${encodeURIComponent(sessionId)}?offset=0&limit=${limit}&direction=newest`;
  const data = await fetchJSON(url);
  return Array.isArray(data?.messages) ? data.messages : [];
}

function flattenTransferContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        if (block.type === 'text') return block.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function truncateTransferText(text, max = 500) {
  const normalized = (text || '').replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max) + '...';
}

function formatTransferMessage(msg) {
  if (!msg || !['user', 'assistant', 'context_summary'].includes(msg.type)) return '';
  const text = truncateTransferText(flattenTransferContent(msg.content), 240);
  if (!text) return '';

  if (msg.type === 'user') {
    return `User: ${text}`;
  }
  if (msg.type === 'assistant') {
    return `Assistant: ${text}`;
  }
  if (msg.type === 'context_summary') {
    return `Previous context summary: ${text}`;
  }
  return '';
}

function buildTransferPrompt(session, recentMessages) {
  const sessionTitle = session.firstPrompt || session.defaultFirstPrompt || 'Untitled session';
  const sourceName = session.sourceLabel || session.source || 'assistant';
  const summaryLine = session.summary
    ? `Dashboard summary: ${truncateTransferText(session.summary, 260)}`
    : 'Saved dashboard summary: (none)';
  const recentBlocks = recentMessages
    .map(formatTransferMessage)
    .filter(Boolean)
    .slice(-6)
    .join('\n');

  return [
    `Continue previous session: ${truncateTransferText(sessionTitle, 100)}`,
    '',
    `A previous ${sourceName} session in this project became inconvenient to continue directly.`,
    `Start from the transferred context below and continue helping from there.`,
    `Project path: ${session.projectPath || '(unknown project)'}`,
    summaryLine,
    'Transferred recent context:',
    '',
    recentBlocks || '(No recent text messages were available in the dashboard.)',
  ].join('\n');
}

async function continueSelectedSessionAsNewCodex() {
  if (!selectedProject || !selectedSession || !sessionMeta) return;

  if (sessionMeta.isDraft) {
    window.alert('Finish creating this draft session before copying it into a new Codex session.');
    return;
  }

  const codexCapability = dashboardCapabilities?.codex;
  if (!codexCapability?.enabled) {
    window.alert('Codex interaction is not currently available.');
    return;
  }

  const sourceProject = selectedProject;
  const sourceSessionId = selectedSession;
  const sourceSession = { ...sessionMeta };
  const recentMessages = await fetchLatestMessagesForTransfer(sourceProject, sourceSessionId, 16);
  const draft = await createDraftSession(sourceProject, 'codex');
  if (!draft) {
    window.alert('Failed to create a new Codex draft session.');
    return;
  }

  const sourceTitle = sourceSession.customTitle || sourceSession.firstPrompt || sourceSession.defaultFirstPrompt || 'Session';
  upsertDraftSession(draft);
  applySessionTitleLocally(
    draft.sessionId,
    `From: ${truncateTransferText(sourceTitle, 48)}`,
    { cleared: false, bumpModified: true }
  );
  selectSessionById(draft.sessionId, { skipFetch: true });

  const transferPrompt = buildTransferPrompt(sourceSession, recentMessages);
  if (typeof window.__dashboardSubmitProgrammaticInteraction !== 'function') {
    window.alert('Programmatic Codex interaction is unavailable.');
    return;
  }

  await window.__dashboardSubmitProgrammaticInteraction({
    projectToken: sourceProject,
    sessionId: draft.sessionId,
    sessionMeta: findSessionMetaById(draft.sessionId) || draft,
    sessionToken: draft.sessionId,
    text: transferPrompt,
    images: [],
    visibleText: `[Transferred context from: ${truncateTransferText(sourceTitle, 60)}]`,
  });
}

function applySessionTitleLocally(sessionId, title, options = {}) {
  const mutate = (session) => {
    if (session.sessionId !== sessionId) return session;
    const defaultFirstPrompt = session.defaultFirstPrompt || session.firstPrompt || '(no prompt)';
    const nextTitle = title || defaultFirstPrompt;
    return {
      ...session,
      defaultFirstPrompt,
      customTitle: options.cleared ? '' : title,
      firstPrompt: nextTitle,
      modified: options.bumpModified ? new Date().toISOString() : session.modified,
    };
  };

  draftSessions = draftSessions.map(mutate);
  sessionList = sessionList.map(mutate);
  persistDraftSessions();

  if (selectedSession === sessionId) {
    sessionMeta = findSessionMetaById(sessionId) || sessionMeta;
    renderChatHeader(sessionMeta);
    persistDashboardState();
  }

  renderDisplayedSessionList();
}

async function renameSelectedSession() {
  if (!selectedSession || !sessionMeta) return;

  const currentTitle = sessionMeta.customTitle || sessionMeta.firstPrompt || sessionMeta.defaultFirstPrompt || '';
  const nextValue = window.prompt(
    'Rename this session in the dashboard. Leave empty to restore the automatic title.',
    currentTitle
  );
  if (nextValue === null) return;

  const trimmed = nextValue.trim();

  if (sessionMeta.isDraft) {
    applySessionTitleLocally(selectedSession, trimmed, {
      cleared: !trimmed,
      bumpModified: true,
    });
    return;
  }

  const result = await renameSessionRequest(selectedProject, selectedSession, trimmed);
  if (!result) {
    window.alert('Failed to rename session.');
    return;
  }

  applySessionTitleLocally(selectedSession, trimmed, {
    cleared: !!result.cleared,
  });
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

      upsertDraftSession(draft);
      renderDisplayedSessionList();
      selectSessionById(draft.sessionId, { skipFetch: true });
    });
  });
}

function selectSessionById(sessionId, options = {}) {
  const meta = findSessionMetaById(sessionId);
  if (!meta) return;

  if (selectedSession && selectedSession !== sessionId) {
    setSessionAutoFollow(selectedSession, isChatNearBottom());
    cacheSessionState();
  }

  selectedSession = sessionId;
  sessionMeta = meta;
  if (!sessionScrollModeBySession.has(sessionId)) {
    setSessionAutoFollow(sessionId, true);
  }
  renderDisplayedSessionList();
  renderChatHeader(sessionMeta);
  persistDashboardState();
  notifySessionSelection();

  if (meta.isDraft) {
    messages = [];
    hasMoreOlder = false;
    totalMessages = 0;
    if ((transientMessagesBySession.get(selectedSession) || []).length > 0) {
      renderCurrentChat();
    } else {
      document.getElementById('chat-messages').innerHTML = '<div class="empty-state">New session ready. Send a message to create it.</div>';
    }
    return;
  }

  if ((transientMessagesBySession.get(sessionId) || []).length > 0 && restoreCachedSessionState(sessionId)) {
    return;
  }

  if (sessionsNeedingHydration.has(sessionId)) {
    reloadCurrentSession();
    return;
  }

  if (!options.skipFetch) {
    loadMessages(selectedProject, sessionId, false);
  }
}

async function deleteSessionById(sessionId) {
  const meta = findSessionMetaById(sessionId);
  if (!meta) return;

  const transientActive = (transientMessagesBySession.get(sessionId) || []).length > 0;
  if (transientActive) {
    window.alert('This session is currently active in the dashboard. Wait for it to finish before deleting.');
    return;
  }

  const confirmed = window.confirm(
    meta.isDraft
      ? 'Delete this draft session?'
      : `Move this ${meta.sourceLabel || meta.source} session to trash?`
  );
  if (!confirmed) return;

  if (meta.isDraft) {
    draftSessions = draftSessions.filter((session) => session.sessionId !== sessionId);
    persistDraftSessions();
    sessionStateCacheBySession.delete(sessionId);
    if (selectedSession === sessionId) {
      selectedSession = null;
      sessionMeta = null;
      messages = [];
      document.getElementById('chat-messages').innerHTML = '<div class="empty-state">Session deleted.</div>';
      renderChatHeader(null);
      persistDashboardState();
      notifySessionSelection();
    }
    renderDisplayedSessionList();
    return;
  }

  const result = await deleteSessionRequest(selectedProject, sessionId);
  if (!result) {
    window.alert('Failed to delete session.');
    return;
  }

  if (selectedSession === sessionId) {
    selectedSession = null;
    sessionMeta = null;
    messages = [];
    transientMessagesBySession.delete(sessionId);
    sessionStateCacheBySession.delete(sessionId);
    renderChatHeader(null);
    document.getElementById('chat-messages').innerHTML = '<div class="empty-state">Session moved to trash.</div>';
    persistDashboardState();
    notifySessionSelection();
  }

  await loadSessions(selectedProject);
}

async function loadProjects() {
  updateStatus('Loading projects...');
  const data = await fetchJSON('/api/projects');
  if (!data) {
    document.getElementById('project-list').innerHTML = '<div class="empty-state">Failed to load projects</div>';
    return;
  }
  projectList = data;
  renderProjectSidebar();
  updateStatusBar();
  const restored = await restoreInitialDashboardView();
  if (!restored && projectList.length > 0) {
    await loadSessions(projectList[0].dirName);
  }
}

async function refreshProjectsSilently() {
  const data = await fetchJSON('/api/projects');
  if (!data) return;
  projectList = data;
  renderProjectSidebar();
  updateStatusBar();
}

async function loadSessions(projectDir, matcher = null) {
  cacheSessionState();
  selectedProject = projectDir;
  selectedSession = null;
  sessionMeta = null;
  messages = [];
  offset = 0;
  hasMoreOlder = false;
  persistDashboardState();

  renderProjectSidebar();
  renderChatHeader(null);
  document.getElementById('chat-messages').innerHTML = '<div class="empty-state">Select a session to view conversation</div>';
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
  reconcileDraftSessionsForProject(projectDir, sessionList);
  renderDisplayedSessionList();
  updateStatusBar();

  if (matcher) {
    const matched = matchSessionByMatcher(displayedSessionList(), matcher);
    if (matched) {
      selectSessionById(matched.sessionId, { skipFetch: matched.isDraft });
      return;
    }
  }

  const fallback = defaultSessionForProject(projectDir);
  if (fallback) {
    selectSessionById(fallback.sessionId, { skipFetch: fallback.isDraft });
  }
}

async function pollSelectedSessionUpdates() {
  if (pollInFlight || document.hidden) return;
  if (!selectedProject) return;
  if (currentSessionHasTransientActivity() && !(sessionMeta && sessionMeta.isDraft && sessionMeta.rawSessionId)) return;

  pollInFlight = true;
  try {
    await refreshProjectsSilently();

    const data = await fetchJSON(`/api/sessions/${encodeURIComponent(selectedProject)}`);
    if (!data) return;

    const previousMeta = selectedSession ? sessionList.find((session) => session.sessionId === selectedSession) || sessionMeta : null;
    sessionList = data;
    reconcileDraftSessionsForProject(selectedProject, sessionList);
    renderDisplayedSessionList();

    if (!selectedSession) return;
    if (sessionMeta && sessionMeta.isDraft) {
      if (sessionMeta.rawSessionId) {
        const bridged = sessionList.find((session) => (
          session.source === sessionMeta.source &&
          session.rawSessionId === sessionMeta.rawSessionId
        ));
        if (bridged) {
          selectSessionById(bridged.sessionId);
        }
      }
      return;
    }

    const nextMeta = sessionList.find((session) => session.sessionId === selectedSession);
    if (!nextMeta) return;

    const changed =
      !previousMeta ||
      previousMeta.modified !== nextMeta.modified ||
      previousMeta.messageCount !== nextMeta.messageCount ||
      previousMeta.model !== nextMeta.model;

    sessionMeta = nextMeta;
    renderChatHeader(sessionMeta);
    persistDashboardState();

    if (changed && !isLoading) {
      await loadMessages(selectedProject, selectedSession, false);
    }
  } finally {
    pollInFlight = false;
  }
}

async function loadMessages(projectDir, sessionId, loadOlder) {
  if (isLoading) return;
  isLoading = true;
  const followBeforeRender = shouldAutoFollowSession(sessionId);

  if (!loadOlder) {
    // Fresh load — get latest messages
    selectedSession = sessionId;
    offset = 0;
    messages = [];
    document.getElementById('chat-messages').innerHTML = '<div class="loading">Loading messages...</div>';

    sessionMeta = findSessionMetaById(sessionId);
    renderDisplayedSessionList();
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
    if (followBeforeRender) {
      scrollChatToBottom();
    }
  }

  cacheSessionState(sessionId, sessionMeta);

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
  draftSessions = loadPersistedDraftSessions();

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

  onSessionDelete((id) => {
    deleteSessionById(id);
  });

  const chatHeader = document.getElementById('chat-header');
  if (chatHeader) {
    chatHeader.addEventListener('click', (event) => {
      const button = event.target.closest('[data-chat-action]');
      if (!button) return;
      const action = button.dataset.chatAction;
      if (action === 'rename-session') {
        renameSelectedSession();
      } else if (action === 'copy-to-new-cx') {
        continueSelectedSessionAsNewCodex();
      }
    });
  }

  const chatContainer = document.getElementById('chat-messages');
  if (chatContainer) {
    chatContainer.addEventListener('scroll', () => {
      if (!selectedSession) return;
      setSessionAutoFollow(selectedSession, isChatNearBottom(chatContainer));
    }, { passive: true });
  }

  // Load projects on start
  loadProjects();

  window.setInterval(() => {
    pollSelectedSessionUpdates();
  }, POLL_INTERVAL_MS);
});
