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
const DASHBOARD_PINNED_KEY = 'session-dashboard-pinned-v1';
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
let projectsDigestSignature = '';
const sessionDigestSignatureByProject = new Map();
let pinnedSessions = [];

function buildProjectDigestSignature(projects) {
  return JSON.stringify((projects || []).map((project) => ([
    project.dirName || '',
    project.sessionCount || 0,
    project.latestModified || project.latestModifiedMs || 0,
    JSON.stringify(project.sourceCounts || {}),
  ])));
}

function buildSessionDigestSignature(sessions) {
  return JSON.stringify((sessions || []).map((session) => ([
    session.sessionId || '',
    session.source || '',
    session.rawSessionId || '',
    session.modified || '',
    session.messageCount || 0,
    session.model || '',
    session.customTitle || session.firstPrompt || '',
  ])));
}

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

function persistPinnedSessions() {
  safeWriteStorage(DASHBOARD_PINNED_KEY, pinnedSessions);
}

function loadPersistedPinnedSessions() {
  const stored = safeReadStorage(DASHBOARD_PINNED_KEY, []);
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

function pinnedSessionIdSet() {
  return new Set(pinnedSessions.map((session) => session.sessionId));
}

window.__dashboardIsPinnedSession = (sessionId) => pinnedSessionIdSet().has(sessionId);

function activeProjectIds() {
  return new Set(activeProjectBySession.values());
}

function renderProjectSidebar() {
  renderProjectList(projectList, selectedProject, activeProjectIds());
}

function renderDisplayedSessionList() {
  renderSessionList(displayedSessionList(), selectedSession, activeInteractionSessions, pinnedSessionIdSet());
}

function findSessionMetaById(id) {
  return displayedSessionList().find((session) => session.sessionId === id) || null;
}

function updatePinnedSessionSnapshot(meta, projectDir = selectedProject) {
  if (!meta?.sessionId) return;
  pinnedSessions = pinnedSessions.map((session) => {
    if (session.sessionId !== meta.sessionId) return session;
    return {
      ...session,
      sessionId: meta.sessionId,
      projectDir: projectDir || session.projectDir,
      projectName: meta.projectName || session.projectName,
      source: meta.source || session.source,
      sourceLabel: meta.sourceLabel || session.sourceLabel,
      sourceShortLabel: meta.sourceShortLabel || session.sourceShortLabel,
      firstPrompt: meta.firstPrompt || meta.defaultFirstPrompt || session.firstPrompt || '(no prompt)',
      customTitle: meta.customTitle || '',
      defaultFirstPrompt: meta.defaultFirstPrompt || meta.firstPrompt || session.defaultFirstPrompt || '(no prompt)',
      summary: meta.summary || '',
      modified: meta.modified || session.modified || '',
      messageCount: meta.messageCount || 0,
      rawSessionId: meta.rawSessionId || session.rawSessionId || '',
      isDraft: !!meta.isDraft,
    };
  });
}

function removePinnedSession(sessionId) {
  const before = pinnedSessions.length;
  pinnedSessions = pinnedSessions.filter((session) => session.sessionId !== sessionId);
  if (pinnedSessions.length !== before) {
    persistPinnedSessions();
  }
}

function pinSession(meta, projectDir = selectedProject) {
  if (!meta?.sessionId || !projectDir) return;
  removePinnedSession(meta.sessionId);
  pinnedSessions.unshift({
    sessionId: meta.sessionId,
    projectDir,
    projectName: meta.projectName || '',
    source: meta.source || '',
    sourceLabel: meta.sourceLabel || '',
    sourceShortLabel: meta.sourceShortLabel || '',
    firstPrompt: meta.firstPrompt || meta.defaultFirstPrompt || '(no prompt)',
    customTitle: meta.customTitle || '',
    defaultFirstPrompt: meta.defaultFirstPrompt || meta.firstPrompt || '(no prompt)',
    summary: meta.summary || '',
    modified: meta.modified || '',
    messageCount: meta.messageCount || 0,
    rawSessionId: meta.rawSessionId || '',
    isDraft: !!meta.isDraft,
  });
  pinnedSessions = pinnedSessions.slice(0, 8);
  persistPinnedSessions();
}

function togglePinSession(sessionId) {
  const meta = findSessionMetaById(sessionId);
  if (!meta) return;
  if (pinnedSessionIdSet().has(sessionId)) {
    removePinnedSession(sessionId);
  } else {
    pinSession(meta);
  }
  renderDisplayedSessionList();
  if (selectedSession === sessionId && sessionMeta) {
    renderChatHeader(sessionMeta);
  }
  renderWorkspaceStrip();
}

function renderWorkspaceStrip() {
  const metaEl = document.getElementById('workspace-strip-meta');
  const cardsEl = document.getElementById('workspace-strip-cards');
  if (!metaEl || !cardsEl) return;

  if (!pinnedSessions.length) {
    metaEl.textContent = 'Pin sessions to keep them one click away.';
    cardsEl.innerHTML = '<div class="workspace-empty">No pinned sessions yet.</div>';
    return;
  }

  const activeCount = pinnedSessions.filter((session) => activeInteractionSessions.has(session.sessionId)).length;
  metaEl.textContent = `${pinnedSessions.length} pinned${activeCount ? ` · ${activeCount} live` : ''}`;

  cardsEl.innerHTML = pinnedSessions.map((session) => {
    const active = session.sessionId === selectedSession;
    const busy = activeInteractionSessions.has(session.sessionId);
    const sourceClass = escapeHtml(session.source || 'unknown');
    const sourceLabel = escapeHtml(session.sourceShortLabel || session.sourceLabel || session.source || '?');
    const rawTitle = session.customTitle || session.firstPrompt || session.defaultFirstPrompt || '(no prompt)';
    const title = escapeHtml(truncate(rawTitle, 34));
    const projectName = escapeHtml(session.projectName || 'project');
    const date = escapeHtml(formatRelativeDate(session.modified || ''));
    const tooltip = escapeHtml(`${rawTitle}\n${projectName} · ${date} · ${session.messageCount || 0} msgs`);
    return `
      <button class="workspace-card${active ? ' active' : ''}${busy ? ' is-busy' : ''}" data-workspace-session="${escapeHtml(session.sessionId)}" title="${tooltip}">
        <span class="workspace-card-top">
          <span class="session-source-badge source-${sourceClass}">${sourceLabel}</span>
          ${busy ? '<span class="workspace-live-dot"></span>' : ''}
          <span class="workspace-card-title">${title}</span>
          <span class="workspace-card-remove" data-workspace-remove="${escapeHtml(session.sessionId)}" title="Remove from workspace">×</span>
        </span>
      </button>
    `;
  }).join('');

  cardsEl.querySelectorAll('[data-workspace-session]').forEach((el) => {
    el.addEventListener('click', async (event) => {
      const removeTarget = event.target.closest('[data-workspace-remove]');
      if (removeTarget) return;
      const sessionId = el.dataset.workspaceSession;
      const pinned = pinnedSessions.find((session) => session.sessionId === sessionId);
      if (!pinned) return;
      if (selectedProject === pinned.projectDir) {
        selectSessionById(sessionId);
        return;
      }
      await loadSessions(pinned.projectDir, {
        sessionId: pinned.sessionId,
        source: pinned.source,
        rawSessionId: pinned.rawSessionId,
      });
      if (selectedSession !== pinned.sessionId) {
        removePinnedSession(pinned.sessionId);
        renderDisplayedSessionList();
        renderWorkspaceStrip();
      }
    });
  });

  cardsEl.querySelectorAll('[data-workspace-remove]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      removePinnedSession(el.dataset.workspaceRemove);
      renderDisplayedSessionList();
      renderWorkspaceStrip();
    });
  });
}

function currentSessionHasTransientActivity() {
  return !!(selectedSession && (transientMessagesBySession.get(selectedSession) || []).length);
}

function currentSessionHasActiveDashboardInteraction() {
  return !!(selectedSession && activeInteractionSessions.has(selectedSession));
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
  const container = chatContainer();
  sessionStateCacheBySession.set(sessionId, {
    messages: messages.slice(),
    offset,
    totalMessages,
    hasMoreOlder,
    scrollTop: container ? container.scrollTop : 0,
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
  } else {
    const container = chatContainer();
    if (container) {
      requestAnimationFrame(() => {
        container.scrollTop = cached.scrollTop || 0;
      });
    }
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
  if (sessionId !== selectedSession) {
    return;
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
  if (sessionId !== selectedSession) {
    return;
  }
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
  const digest = await fetchJSON(`/api/sessions-digest/${encodeURIComponent(selectedProject)}`);
  if (!digest) return false;

  const nextDigestSignature = buildSessionDigestSignature(digest);
  const previousDigestSignature = sessionDigestSignatureByProject.get(selectedProject) || '';
  if (nextDigestSignature === previousDigestSignature) {
    return false;
  }

  const data = await fetchJSON(`/api/sessions/${encodeURIComponent(selectedProject)}`);
  if (!data) return false;

  const previousSelected = selectedSession;
  sessionList = data;
  sessionDigestSignatureByProject.set(selectedProject, buildSessionDigestSignature(sessionList));
  reconcileDraftSessionsForProject(selectedProject, sessionList);
  renderDisplayedSessionList();

  if (previousSelected) {
    const nextMeta = findSessionMetaById(previousSelected);
    if (nextMeta) {
      sessionMeta = nextMeta;
      updatePinnedSessionSnapshot(nextMeta, selectedProject);
      renderChatHeader(sessionMeta);
      renderWorkspaceStrip();
      persistDashboardState();
    }
  }

  return true;
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
    renderWorkspaceStrip();
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
window.__dashboardPrepareSessionForNewInteraction = async (sessionId) => {
  if (!sessionId || sessionId !== selectedSession) return;
  const hasTransient = (transientMessagesBySession.get(sessionId) || []).length > 0;
  const isActive = activeInteractionSessions.has(sessionId);
  if (sessionsNeedingHydration.has(sessionId) || (hasTransient && !isActive)) {
    await reloadCurrentSession();
  }
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
  updatePinnedSessionSnapshot(findSessionMetaById(sessionId) || draftSessions.find((session) => session.sessionId === sessionId) || null);
  persistDraftSessions();
  persistPinnedSessions();

  if (selectedSession === sessionId) {
    sessionMeta = findSessionMetaById(sessionId) || sessionMeta;
    renderChatHeader(sessionMeta);
    persistDashboardState();
  }

  renderDisplayedSessionList();
  renderWorkspaceStrip();
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
  setSessionAutoFollow(sessionId, true);
  updatePinnedSessionSnapshot(meta, selectedProject);
  renderDisplayedSessionList();
  renderChatHeader(sessionMeta);
  renderWorkspaceStrip();
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

  if (sessionsNeedingHydration.has(sessionId)) {
    reloadCurrentSession();
    return;
  }

  if (activeInteractionSessions.has(sessionId) && (transientMessagesBySession.get(sessionId) || []).length > 0 && restoreCachedSessionState(sessionId)) {
    return;
  }

  if (!activeInteractionSessions.has(sessionId) && (transientMessagesBySession.get(sessionId) || []).length > 0) {
    clearTransientMessagesForSession(sessionId);
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
    removePinnedSession(sessionId);
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
    renderWorkspaceStrip();
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

  removePinnedSession(sessionId);
  await loadSessions(selectedProject);
  renderWorkspaceStrip();
}

async function loadProjects() {
  updateStatus('Loading projects...');
  const data = await fetchJSON('/api/projects');
  if (!data) {
    document.getElementById('project-list').innerHTML = '<div class="empty-state">Failed to load projects</div>';
    return;
  }
  projectList = data;
  projectsDigestSignature = buildProjectDigestSignature(projectList);
  renderProjectSidebar();
  renderWorkspaceStrip();
  updateStatusBar();
  const restored = await restoreInitialDashboardView();
  if (!restored && projectList.length > 0) {
    await loadSessions(projectList[0].dirName);
  }
}

async function refreshProjectsSilently() {
  const digest = await fetchJSON('/api/projects-digest');
  if (!digest) return false;

  const nextDigestSignature = buildProjectDigestSignature(digest);
  if (nextDigestSignature === projectsDigestSignature) {
    return false;
  }

  const data = await fetchJSON('/api/projects');
  if (!data) return false;
  projectList = data;
  projectsDigestSignature = buildProjectDigestSignature(projectList);
  renderProjectSidebar();
  renderWorkspaceStrip();
  updateStatusBar();
  return true;
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
  sessionDigestSignatureByProject.set(projectDir, buildSessionDigestSignature(sessionList));
  reconcileDraftSessionsForProject(projectDir, sessionList);
  pinnedSessions = pinnedSessions.filter((session) => {
    if (session.projectDir !== projectDir) return true;
    return displayedSessionList().some((candidate) => candidate.sessionId === session.sessionId);
  });
  persistPinnedSessions();
  renderDisplayedSessionList();
  renderWorkspaceStrip();
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

  if (currentSessionHasTransientActivity()) {
    if (currentSessionHasActiveDashboardInteraction()) {
      return;
    }

    // A previous dashboard interaction left stale transient items behind.
    // They should not block external CLI refreshes for this session.
    clearTransientMessagesForSession(selectedSession);
    sessionsNeedingHydration.delete(selectedSession);
    sessionStateCacheBySession.delete(selectedSession);
  }

  pollInFlight = true;
  try {
    await refreshProjectsSilently();

    const previousMeta = selectedSession ? sessionList.find((session) => session.sessionId === selectedSession) || sessionMeta : null;
    await refreshCurrentProjectSessionsSilently();

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
    updatePinnedSessionSnapshot(nextMeta, selectedProject);
    renderChatHeader(sessionMeta);
    renderWorkspaceStrip();
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
    const chatContainer = document.getElementById('chat-messages');
    const prevScrollHeight = chatContainer.scrollHeight;
    const prevScrollTop = chatContainer.scrollTop;
    messages = [...data.messages, ...messages];
    renderCurrentChat();
    // Maintain scroll position after prepending
    chatContainer.scrollTop = prevScrollTop + (chatContainer.scrollHeight - prevScrollHeight);
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
  pinnedSessions = loadPersistedPinnedSessions();
  renderWorkspaceStrip();

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

  onSessionPin((id) => {
    togglePinSession(id);
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
      } else if (action === 'toggle-pin-session' && selectedSession) {
        togglePinSession(selectedSession);
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
