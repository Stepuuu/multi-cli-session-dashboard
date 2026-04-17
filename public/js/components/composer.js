// composer.js — Interactive prompt composer for selected sessions

let composerCapabilities = null;
let composerClaudeProfiles = [];
let composerClaudeProfilesLoadedAt = 0;
let composerClaudeProfilesPromise = null;
let composerAttachments = [];
let composerSelection = { project: null, session: null, sessionMeta: null };
let composerTransientCounter = 0;
const COMPOSER_MAX_HEIGHT = 260;
const COMPOSER_CLAUDE_PROFILE_TTL_MS = 15000;
const COMPOSER_SUBAGENT_POLL_INTERVAL_MS = 2000;
const COMPOSER_SUBAGENT_TAIL = 20;
const COMPOSER_SUBAGENT_INTERACTION_LOOKBACK_MS = 15000;

const composerSendingSessions = new Set();
const composerStatusBySession = new Map();
const composerTransientMessagesBySession = new Map();
const composerImageStateBySession = new Map();
const composerControllersBySession = new Map();
const composerSubagentPollersBySession = new Map();
const composerClaudeProfileOverrideBySession = new Map();
const composerLatestInteractionTokenBySession = new Map();
const composerActivityEntriesBySession = new Map();
const composerActivityHideTimersBySession = new Map();
const composerActivityExpandedSessions = new Set();

function composerEl(id) {
  return document.getElementById(id);
}

function composerFetch(url, options = {}) {
  const sharedFetch = typeof window.__dashboardFetch === 'function' ? window.__dashboardFetch : fetch;
  return sharedFetch(url, options);
}

function currentSessionId() {
  return composerSelection.session || '';
}

function currentSessionMeta() {
  return composerSelection.sessionMeta || null;
}

function currentCapability() {
  const source = composerSelection.sessionMeta && composerSelection.sessionMeta.source;
  return source && composerCapabilities ? composerCapabilities[source] : null;
}

function normalizeComposerErrorMessage(errorLike) {
  const asError = errorLike instanceof Error
    ? errorLike
    : new Error(typeof errorLike === 'string' ? errorLike : '');
  const backendUnavailable = typeof window.__dashboardIsBackendUnavailableError === 'function'
    && window.__dashboardIsBackendUnavailableError(asError);

  if (backendUnavailable && typeof window.__dashboardBackendUnavailableMessage === 'function') {
    return window.__dashboardBackendUnavailableMessage();
  }

  const message = typeof errorLike === 'string'
    ? errorLike
    : (typeof errorLike?.message === 'string' ? errorLike.message : '');
  return message || 'Interaction failed.';
}

function currentClaudeProfileOverride() {
  return composerClaudeProfileOverrideBySession.get(currentSessionId()) || '';
}

function effectiveClaudeProfileHint() {
  const meta = currentSessionMeta();
  if (!meta || meta.source !== 'claude') return '';
  return currentClaudeProfileOverride() || meta.claudeProfile || '';
}

function renderClaudeProfileSelector() {
  const container = composerEl('composer-claude-profile');
  if (!container) return;

  const meta = currentSessionMeta();
  if (!meta || meta.source !== 'claude' || !composerClaudeProfiles.length) {
    container.innerHTML = '';
    return;
  }

  const effectiveProfile = effectiveClaudeProfileHint();
  const current = effectiveProfile || '__auto__';
  const currentSource = meta.claudeConfigSource || 'unknown';
  const currentLabel = meta.claudeProfileLabel || (meta.claudeModel ? meta.claudeModel : 'AUTO');
  const currentHint = meta.claudeProfileHint || '';

  const options = [
    '<option value="__auto__">AUTO</option>',
    ...composerClaudeProfiles.map((profile) => (
      `<option value="${escapeHtml(profile.name)}"${profile.name === current ? ' selected' : ''}>${escapeHtml(profile.label)}${profile.anthropicModel ? ` · ${escapeHtml(profile.anthropicModel)}` : ''}</option>`
    )),
  ].join('');

  container.innerHTML = `
    <div class="composer-profile-row">
      <span class="composer-profile-label">CLAUDE PROFILE</span>
      <select id="composer-claude-profile-select" class="composer-profile-select">
        ${options}
      </select>
      <span class="composer-profile-note">using: ${escapeHtml(currentLabel)}${currentHint ? ` (${escapeHtml(currentHint)})` : ''} · ${escapeHtml(currentSource)}</span>
    </div>
  `;

  const select = composerEl('composer-claude-profile-select');
  if (select) {
    select.value = current;
    select.addEventListener('change', () => {
      const value = select.value === '__auto__' ? '' : select.value;
      if (value) {
        composerClaudeProfileOverrideBySession.set(currentSessionId(), value);
      } else {
        composerClaudeProfileOverrideBySession.delete(currentSessionId());
      }
      renderComposer();
    });
  }
}

function imageSummaryText(selectedCount, decodedCount, transport) {
  if (!selectedCount) return '';
  if (decodedCount === 0) return `Backend accepted 0/${selectedCount} images.`;
  if (transport === 'native') return `Backend accepted ${decodedCount}/${selectedCount} images and attached them natively.`;
  if (transport === 'local-file') return `Backend accepted ${decodedCount}/${selectedCount} images and stored them as local files.`;
  return `Backend accepted ${decodedCount}/${selectedCount} images.`;
}

function autoResizeComposer() {
  const textarea = composerEl('composer-input');
  if (!textarea) return;

  textarea.style.height = 'auto';
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, 92), COMPOSER_MAX_HEIGHT);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
}

function getComposerStatus(sessionId) {
  return composerStatusBySession.get(sessionId) || { text: 'Idle', isError: false };
}

function setComposerStatusForSession(sessionId, text, isError) {
  if (!sessionId) return;
  composerStatusBySession.set(sessionId, {
    text: text || 'Idle',
    isError: !!isError,
  });

  if (sessionId !== currentSessionId()) return;
  const statusEl = composerEl('composer-status');
  if (!statusEl) return;
  statusEl.textContent = text || 'Idle';
  statusEl.classList.toggle('is-error', !!isError);
}

function renderImageStateBar() {
  const container = composerEl('composer-image-state');
  if (!container) return;

  const imageState = composerImageStateBySession.get(currentSessionId());
  if (!imageState) {
    container.innerHTML = '';
    return;
  }

  const level = imageState.decodedCount === 0
    ? 'error'
    : imageState.decodedCount < imageState.selectedCount
      ? 'warn'
      : 'ok';

  const summary = imageSummaryText(
    imageState.selectedCount,
    imageState.decodedCount,
    imageState.transport
  );

  container.innerHTML = `
    <div class="composer-image-pill ${level}">
      <span class="composer-image-pill-label">IMAGE</span>
      <span>${escapeHtml(summary)}</span>
    </div>
  `;
}

function getComposerActivityEntries(sessionId) {
  return composerActivityEntriesBySession.get(sessionId) || [];
}

function pushComposerActivityEntry(sessionId, type, text) {
  if (!sessionId || !text) return;
  clearComposerActivityHideTimer(sessionId);
  const next = [...getComposerActivityEntries(sessionId), {
    id: nextTransientId(),
    type,
    text,
    timestamp: new Date().toISOString(),
  }].slice(-12);
  composerActivityEntriesBySession.set(sessionId, next);
  if (sessionId === currentSessionId()) {
    renderComposerActivityLog();
  }
}

function clearComposerActivityEntries(sessionId) {
  composerActivityEntriesBySession.delete(sessionId);
  if (sessionId === currentSessionId()) {
    renderComposerActivityLog();
  }
}

function clearComposerActivityHideTimer(sessionId) {
  const timer = composerActivityHideTimersBySession.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    composerActivityHideTimersBySession.delete(sessionId);
  }
}

function isComposerActivityExpanded(sessionId) {
  return composerActivityExpandedSessions.has(sessionId);
}

function toggleComposerActivityExpanded(sessionId = currentSessionId()) {
  if (!sessionId) return;
  if (composerActivityExpandedSessions.has(sessionId)) {
    composerActivityExpandedSessions.delete(sessionId);
  } else {
    composerActivityExpandedSessions.add(sessionId);
    clearComposerActivityHideTimer(sessionId);
  }
  renderComposerActivityLog();
}

function scheduleComposerActivityHide(sessionId, delayMs = 1800) {
  if (isComposerActivityExpanded(sessionId)) return;
  clearComposerActivityHideTimer(sessionId);
  const timer = setTimeout(() => {
    composerActivityEntriesBySession.delete(sessionId);
    composerActivityHideTimersBySession.delete(sessionId);
    if (sessionId === currentSessionId()) {
      renderComposerActivityLog();
    }
  }, delayMs);
  composerActivityHideTimersBySession.set(sessionId, timer);
}

function renderComposerActivityLog() {
  const shell = composerEl('composer-activity-shell');
  const title = composerEl('composer-activity-title');
  const container = composerEl('composer-activity-log');
  if (!container || !shell || !title) return;

  const sessionId = currentSessionId();
  const expanded = isComposerActivityExpanded(sessionId);
  const items = getComposerActivityEntries(sessionId);
  if (!items.length) {
    shell.classList.add('is-hidden');
    shell.classList.remove('is-expanded');
    title.textContent = 'LIVE ACTIVITY';
    container.innerHTML = '<div class="composer-activity-empty">No live activity yet.</div>';
    return;
  }

  shell.classList.remove('is-hidden');
  shell.classList.toggle('is-expanded', expanded);
  title.textContent = expanded ? 'LIVE ACTIVITY · Collapse' : 'LIVE ACTIVITY · Expand';
  container.innerHTML = items.map((item) => `
    <div class="composer-activity-entry ${escapeHtml(item.type)}">${escapeHtml(item.text)}</div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

function getTransientMessages(sessionId) {
  return composerTransientMessagesBySession.get(sessionId) || [];
}

function syncTransientTimelineForSession(sessionId) {
  if (
    sessionId === currentSessionId() &&
    typeof window.__dashboardSetTransientMessagesForSession === 'function'
  ) {
    window.__dashboardSetTransientMessagesForSession(
      sessionId,
      getTransientMessages(sessionId)
    );
  }
}

function resetTransientTimelineForSession(sessionId) {
  composerTransientMessagesBySession.delete(sessionId);
  if (
    sessionId === currentSessionId() &&
    typeof window.__dashboardClearTransientMessagesForSession === 'function'
  ) {
    window.__dashboardClearTransientMessagesForSession(sessionId);
  }
}

function composerSerializeComparable(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function nextTransientId() {
  composerTransientCounter += 1;
  return `composer-tmp-${composerTransientCounter}`;
}

function markAllTransientNotLive(sessionId) {
  const next = getTransientMessages(sessionId).map((msg) => ({ ...msg, live: false }));
  composerTransientMessagesBySession.set(sessionId, next);
}

function markAssistantTransientNotLive(sessionId) {
  const next = getTransientMessages(sessionId).map((msg) => (
    typeof msg._transientKind === 'string' && msg._transientKind.startsWith('assistant-live')
      ? { ...msg, live: false, pending: false }
      : msg
  ));
  composerTransientMessagesBySession.set(sessionId, next);
  syncTransientTimelineForSession(sessionId);
}

function pushTransientMessageForSession(sessionId, sessionMeta, message) {
  const transientMessage = {
    timestamp: new Date().toISOString(),
    source: sessionMeta ? sessionMeta.source : '',
    sourceLabel: sessionMeta ? sessionMeta.sourceLabel : '',
    sourceShortLabel: sessionMeta ? sessionMeta.sourceShortLabel : '',
    ...message,
    _transientId: message._transientId || nextTransientId(),
  };
  const next = [...getTransientMessages(sessionId), transientMessage];
  composerTransientMessagesBySession.set(sessionId, next);
  syncTransientTimelineForSession(sessionId);
  return transientMessage._transientId;
}

function updateTransientMessageForSession(sessionId, id, patch) {
  const current = getTransientMessages(sessionId);
  let changed = false;
  const next = current.map((msg) => {
    if (msg._transientId !== id) return msg;
    const updated = { ...msg, ...patch };
    if (composerSerializeComparable(updated) !== composerSerializeComparable(msg)) {
      changed = true;
      return updated;
    }
    return msg;
  });
  if (!changed) return;
  composerTransientMessagesBySession.set(sessionId, next);
  syncTransientTimelineForSession(sessionId);
}

function ensureLiveAssistantMessage(sessionId, sessionMeta, itemId = '') {
  const liveKind = itemId ? `assistant-live:${itemId}` : 'assistant-live';
  const existing = getTransientMessages(sessionId).find((msg) => msg._transientKind === liveKind);
  if (existing) return existing._transientId;

  markAssistantTransientNotLive(sessionId);
  return pushTransientMessageForSession(sessionId, sessionMeta, {
    type: 'assistant',
    roleLabel: (sessionMeta && (sessionMeta.sourceLabel || sessionMeta.sourceShortLabel)) || 'ASSISTANT',
    content: '正在回复...',
    live: true,
    pending: true,
    _transientKind: liveKind,
  });
}

function pushLiveStatusMessage(sessionId, sessionMeta, text, isError, type = 'status') {
  markAllTransientNotLive(sessionId);
  return pushTransientMessageForSession(sessionId, sessionMeta, {
    type,
    content: text,
    live: true,
    pending: !isError,
    _transientKind: isError ? 'status-error' : `${type}-live`,
  });
}

function finalizeLiveMessages(sessionId) {
  const next = getTransientMessages(sessionId).map((msg) => ({
    ...msg,
    live: false,
    pending: false,
  }));
  composerTransientMessagesBySession.set(sessionId, next);
  syncTransientTimelineForSession(sessionId);
}

function appendTransientEventMessage(sessionId, sessionMeta, type, content) {
  let payload;
  if (type && typeof type === 'object') {
    payload = { ...type };
  } else {
    payload = {
      type,
      content,
    };
  }
  const messageType = payload.type || 'status';
  const body = payload.content || payload.message || '';
  if (!body && !payload.toolName && !payload.command && !(Array.isArray(payload.changes) && payload.changes.length)) {
    return '';
  }
  delete payload.message;
  return pushTransientMessageForSession(sessionId, sessionMeta, {
    ...payload,
    type: messageType,
    content: body,
    live: false,
    pending: false,
  });
}

function dropTransientSubagentGroups(sessionId) {
  if (!sessionId) return;
  const current = getTransientMessages(sessionId);
  const next = current.filter((msg) => (
    msg.type !== 'subagent_group'
    && !(typeof msg._transientKind === 'string' && msg._transientKind.startsWith('subagent-group:'))
  ));
  if (next.length === current.length) return;
  if (next.length > 0) {
    composerTransientMessagesBySession.set(sessionId, next);
  } else {
    composerTransientMessagesBySession.delete(sessionId);
  }
  syncTransientTimelineForSession(sessionId);
}

function stopSubagentPolling(sessionId) {
  const poller = composerSubagentPollersBySession.get(sessionId);
  if (!poller) return;
  poller.stopped = true;
  if (poller.timer) clearTimeout(poller.timer);
  if (poller.controller) poller.controller.abort();
  composerSubagentPollersBySession.delete(sessionId);
}

function parseComposerTimestampMs(value) {
  if (!value) return Number.NaN;
  const date = new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function isTerminalComposerSubagentStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'completed'
    || normalized === 'aborted'
    || normalized === 'failed'
    || normalized === 'error'
    || normalized === 'stale';
}

function shouldIncludePolledSubagentGroup(group, poller) {
  const rawSessionId = group?.subagent?.rawSessionId || '';
  if (!rawSessionId || !poller) return false;
  if (poller.seenSubagentIds?.has(rawSessionId)) return true;

  const interactionStartMs = Number(poller.interactionStartMs || 0);
  const cutoffMs = interactionStartMs > 0
    ? interactionStartMs - COMPOSER_SUBAGENT_INTERACTION_LOOKBACK_MS
    : Number.NEGATIVE_INFINITY;
  const startedMs = parseComposerTimestampMs(group?.subagent?.startedAt || group?.timestamp || '');
  const completedMs = parseComposerTimestampMs(group?.subagent?.completedAt || '');
  const newestMs = Math.max(
    Number.isFinite(startedMs) ? startedMs : Number.NEGATIVE_INFINITY,
    Number.isFinite(completedMs) ? completedMs : Number.NEGATIVE_INFINITY,
  );
  const status = group?.subagent?.status || '';

  const isRecent = Number.isFinite(newestMs) && newestMs >= cutoffMs;
  if (isRecent) {
    poller.seenSubagentIds.add(rawSessionId);
    return true;
  }

  if (!isTerminalComposerSubagentStatus(status) && Number.isFinite(startedMs) && startedMs >= cutoffMs) {
    poller.seenSubagentIds.add(rawSessionId);
    return true;
  }

  return false;
}

function upsertTransientSubagentGroup(sessionId, sessionMeta, group) {
  if (!group?.subagent?.rawSessionId) return '';
  const kind = `subagent-group:${group.subagent.rawSessionId}`;
  const patch = {
    ...group,
    type: 'subagent_group',
    live: group.subagent?.status !== 'completed',
    pending: group.subagent?.status !== 'completed',
    _transientKind: kind,
  };
  const existing = getTransientMessages(sessionId).find((msg) => msg._transientKind === kind);
  if (existing) {
    updateTransientMessageForSession(sessionId, existing._transientId, patch);
    return existing._transientId;
  }
  return pushTransientMessageForSession(sessionId, sessionMeta, patch);
}

async function pollSubagentGroups(sessionId, projectToken, sessionToken, sessionMeta, interactionToken) {
  const poller = composerSubagentPollersBySession.get(sessionId);
  if (!poller || poller.stopped) return;
  if (composerLatestInteractionTokenBySession.get(sessionId) !== interactionToken) {
    stopSubagentPolling(sessionId);
    return;
  }

  poller.pollCount = (poller.pollCount || 0) + 1;
  const fresh = poller.pollCount % 3 === 1 ? '1' : '0';
  const url = `/api/subagent-groups/${encodeURIComponent(projectToken)}/${encodeURIComponent(sessionToken)}?tail=${COMPOSER_SUBAGENT_TAIL}&fresh=${fresh}`;
  const controller = new AbortController();
  poller.controller = controller;

  try {
    const response = await composerFetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const groups = (Array.isArray(payload?.groups) ? payload.groups : []).filter((group) => (
      shouldIncludePolledSubagentGroup(group, poller)
    ));
    for (const group of groups) {
      upsertTransientSubagentGroup(sessionId, sessionMeta, group);
    }
  } catch (err) {
    if (poller.stopped || controller.signal.aborted) return;
    console.error('Subagent poll failed', err);
  } finally {
    if (poller.controller === controller) {
      poller.controller = null;
    }
  }

  if (poller.stopped) return;
  poller.timer = setTimeout(() => {
    pollSubagentGroups(sessionId, projectToken, sessionToken, sessionMeta, interactionToken);
  }, COMPOSER_SUBAGENT_POLL_INTERVAL_MS);
}

function startSubagentPolling(sessionId, projectToken, sessionToken, sessionMeta, interactionToken) {
  if (!sessionId || !projectToken || !sessionToken || sessionMeta?.source !== 'codex' || sessionMeta?.isDraft) {
    return;
  }
  stopSubagentPolling(sessionId);
  dropTransientSubagentGroups(sessionId);
  composerSubagentPollersBySession.set(sessionId, {
    stopped: false,
    timer: null,
    controller: null,
    pollCount: 0,
    interactionStartMs: Date.now(),
    seenSubagentIds: new Set(),
  });
  pollSubagentGroups(sessionId, projectToken, sessionToken, sessionMeta, interactionToken);
}

function resetComposerAttachments() {
  composerAttachments = [];
  composerImageStateBySession.delete(currentSessionId());
  renderComposer();
}

function removeComposerAttachment(index) {
  composerAttachments.splice(index, 1);
  renderComposer();
}

function renderAttachments() {
  const container = composerEl('composer-attachments');
  if (!container) return;
  if (!composerAttachments.length) {
    container.innerHTML = '';
    return;
  }

  const currentId = currentSessionId();
  const sending = composerSendingSessions.has(currentId);

  container.innerHTML = composerAttachments.map((attachment, index) => `
    <div class="composer-attachment">
      <img src="${escapeHtml(attachment.dataUrl)}" alt="${escapeHtml(attachment.name)}" class="composer-attachment-thumb">
      <div class="composer-attachment-meta">
        <span class="composer-attachment-name">${escapeHtml(attachment.name)}</span>
        <span class="composer-attachment-type">${escapeHtml(attachment.type)}</span>
      </div>
      <button class="composer-attachment-remove" data-index="${index}" ${sending ? 'disabled' : ''}>×</button>
    </div>
  `).join('');

  container.querySelectorAll('.composer-attachment-remove').forEach((button) => {
    button.addEventListener('click', () => {
      removeComposerAttachment(parseInt(button.dataset.index, 10));
    });
  });
}

function renderComposer() {
  const textarea = composerEl('composer-input');
  const sendBtn = composerEl('composer-send');
  const stopBtn = composerEl('composer-stop');
  const uploadBtn = composerEl('composer-upload');
  const metaEl = composerEl('composer-meta');
  const statusEl = composerEl('composer-status');
  const capability = currentCapability();
  const selected = !!(composerSelection.project && composerSelection.session && composerSelection.sessionMeta);
  const sessionId = currentSessionId();
  const sending = composerSendingSessions.has(sessionId);
  const enabled = selected && capability && capability.enabled && !sending;
  const status = getComposerStatus(sessionId);

  if (!selected) {
    metaEl.textContent = 'Select a session to start interacting.';
  } else if (!capability) {
    metaEl.textContent = 'Loading capabilities...';
  } else {
    const parts = [capability.note];
    if (composerAttachments.length > 0) {
      parts.push(`Selected ${composerAttachments.length} image${composerAttachments.length === 1 ? '' : 's'}.`);
    }
    metaEl.textContent = parts.filter(Boolean).join(' ');
  }

  textarea.disabled = !enabled;
  sendBtn.disabled = !enabled || (!textarea.value.trim() && composerAttachments.length === 0);
  stopBtn.disabled = !sending;
  uploadBtn.disabled = !enabled;
  sendBtn.textContent = sending ? 'Sending...' : 'Send';
  stopBtn.textContent = 'Stop';
  textarea.placeholder = capability && capability.directImages
    ? 'Type a message. Images will be attached directly.'
    : 'Type a message. Images will be saved locally and referenced in the prompt.';

  if (statusEl) {
    statusEl.textContent = status.text;
    statusEl.classList.toggle('is-error', !!status.isError);
  }

  renderAttachments();
  renderClaudeProfileSelector();
  renderImageStateBar();
  renderComposerActivityLog();
  autoResizeComposer();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function addComposerFiles(fileList) {
  if (composerSendingSessions.has(currentSessionId())) return;

  const incoming = Array.from(fileList || []).filter((file) => file.type.startsWith('image/'));
  for (const file of incoming) {
    const dataUrl = await fileToDataUrl(file);
    composerAttachments.push({
      name: file.name || 'image',
      type: file.type || 'image/png',
      dataUrl,
    });
  }

  renderComposer();
}

function clearComposerInput() {
  composerEl('composer-input').value = '';
  resetComposerAttachments();
  autoResizeComposer();
}

function cloneAttachmentsForRequest() {
  return composerAttachments.map((attachment) => ({ ...attachment }));
}

function formatOutboundUserContent(text, imageCount) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const imageLine = imageCount > 0
    ? `[${imageCount} image${imageCount === 1 ? '' : 's'} attached]`
    : '';

  if (trimmed && imageLine) return `${trimmed}\n\n${imageLine}`;
  if (trimmed) return trimmed;
  return imageLine;
}

function consumeNdjsonChunk(buffer, handleEvent) {
  let rest = buffer;
  while (true) {
    const idx = rest.indexOf('\n');
    if (idx === -1) break;
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (!line) continue;
    try {
      handleEvent(JSON.parse(line));
    } catch (err) {
      console.error('Failed to parse stream event', err, line);
    }
  }
  return rest;
}

function scheduleFinalHydration(projectToken, sessionId, requestState) {
  if (!sessionId || !requestState) return;
  if (requestState.finalizeScheduled) return;
  requestState.finalizeScheduled = true;
  setTimeout(() => {
    finalizeComposerHydration(projectToken, sessionId, requestState, requestState.interactionToken);
  }, 300);
}

function buildStreamEventHandler(sessionId, sessionMeta, requestState, projectToken) {
  return function applyStreamEvent(event) {
    if (event.type === 'status') {
      setComposerStatusForSession(sessionId, event.message || 'Working...', false);
      pushComposerActivityEntry(sessionId, 'status', event.message || 'Working...');
      return;
    }

    if (event.type === 'meta') {
      const sourceLabel = (sessionMeta && (sessionMeta.sourceLabel || sessionMeta.sourceShortLabel)) || event.source;
      setComposerStatusForSession(sessionId, `Connected to ${sourceLabel}`, false);
      return;
    }

    if (event.type === 'session_created') {
      requestState.createdSession = {
        source: event.source,
        rawSessionId: event.rawSessionId,
      };
      if (typeof window.__dashboardRememberCreatedSessionForDraft === 'function') {
        window.__dashboardRememberCreatedSessionForDraft(sessionId, requestState.createdSession);
      }
      return;
    }

    if (event.type === 'image_state') {
      composerImageStateBySession.set(sessionId, {
        selectedCount: event.selectedCount || 0,
        decodedCount: event.decodedCount || 0,
        transport: event.transport || '',
      });
      if (sessionId === currentSessionId()) {
        renderComposer();
      }
      return;
    }

    if (event.type === 'tool_event') {
      setComposerStatusForSession(sessionId, event.message || 'Tool running...', false);
      pushComposerActivityEntry(sessionId, 'tool', event.message || 'Tool running...');
      appendTransientEventMessage(sessionId, sessionMeta, {
        ...event,
        type: 'tool_event',
        content: event.content || event.message || 'Tool running...',
      });
      return;
    }

    if (event.type === 'tool_result') {
      setComposerStatusForSession(sessionId, 'Tool completed.', false);
      pushComposerActivityEntry(sessionId, 'result', event.message || 'Tool completed.');
      appendTransientEventMessage(sessionId, sessionMeta, {
        ...event,
        type: 'tool_result',
        content: event.content || event.message || 'Tool completed.',
      });
      return;
    }

    if (event.type === 'assistant_delta') {
      setComposerStatusForSession(sessionId, '正在回复...', false);
      const messageId = ensureLiveAssistantMessage(sessionId, sessionMeta, event.itemId || '');
      const current = getTransientMessages(sessionId).find((msg) => msg._transientId === messageId);
      const currentText = typeof current?.content === 'string' && current.content !== '正在回复...'
        ? current.content
        : '';
      updateTransientMessageForSession(sessionId, messageId, {
        content: currentText + (event.text || ''),
        live: true,
        pending: true,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (event.type === 'assistant_final') {
      setComposerStatusForSession(sessionId, '已收到回复', false);
      const liveKind = event.itemId ? `assistant-live:${event.itemId}` : 'assistant-live';
      const existing = getTransientMessages(sessionId).find((msg) => msg._transientKind === liveKind);
      const roleLabel = event.phase === 'commentary'
        ? 'COMMENTARY'
        : ((sessionMeta && (sessionMeta.sourceLabel || sessionMeta.sourceShortLabel)) || 'ASSISTANT');
      if (existing) {
        updateTransientMessageForSession(sessionId, existing._transientId, {
          content: event.text || existing.content,
          live: false,
          pending: false,
          roleLabel,
          timestamp: new Date().toISOString(),
        });
      } else {
        pushTransientMessageForSession(sessionId, sessionMeta, {
          type: 'assistant',
          roleLabel,
          content: event.text || '',
          live: false,
          pending: false,
        });
      }
      if (sessionMeta?.source === 'claude') {
        if (typeof window.__dashboardMarkSessionNeedsHydration === 'function') {
          window.__dashboardMarkSessionNeedsHydration(sessionId);
        }
        scheduleFinalHydration(projectToken, sessionId, requestState);
      }
      return;
    }

    if (event.type === 'error') {
      stopSubagentPolling(sessionId);
      const message = normalizeComposerErrorMessage(event.message || 'Interaction failed.');
      setComposerStatusForSession(sessionId, message, true);
      pushComposerActivityEntry(sessionId, 'error', `Error: ${message}`);
      scheduleComposerActivityHide(sessionId, 2600);
      return;
    }

    if (event.type === 'done') {
      stopSubagentPolling(sessionId);
      finalizeLiveMessages(sessionId);
      pushComposerActivityEntry(sessionId, 'status', 'Turn completed.');
      setComposerStatusForSession(sessionId, 'Done', false);
      scheduleComposerActivityHide(sessionId, 1800);
      if (typeof window.__dashboardMarkSessionNeedsHydration === 'function') {
        window.__dashboardMarkSessionNeedsHydration(sessionId);
      }
      scheduleFinalHydration(projectToken, sessionId, requestState);
    }
  }
}

function stopComposerForSession(sessionId, options = {}) {
  const controller = composerControllersBySession.get(sessionId);
  if (!controller) return false;

  stopSubagentPolling(sessionId);
  composerControllersBySession.delete(sessionId);
  composerSendingSessions.delete(sessionId);
  if (typeof window.__dashboardSetSessionActivityState === 'function') {
    window.__dashboardSetSessionActivityState(sessionId, false, options.projectToken || '');
  }
  setComposerStatusForSession(sessionId, options.message || 'Stopped.', false);
  markAllTransientNotLive(sessionId);
  pushComposerActivityEntry(sessionId, 'status', options.message || 'Stopped.');
  scheduleComposerActivityHide(sessionId, 1400);
  renderComposer();
  controller.abort();
  return true;
}

async function finalizeComposerHydration(projectToken, sessionId, requestState, interactionToken) {
  if (composerLatestInteractionTokenBySession.get(sessionId) !== interactionToken) {
    return;
  }
  if (typeof window.__dashboardFinalizeInteractionHydration !== 'function') {
    return;
  }

  await window.__dashboardFinalizeInteractionHydration({
    projectToken,
    sessionId,
    createdSession: requestState?.createdSession || null,
  });
}

async function submitInteraction({
  projectToken,
  sessionId,
  sessionMeta,
  sessionToken,
  text,
  images = [],
  visibleText = null,
}) {
  if (composerSendingSessions.has(sessionId)) return;
  if (!projectToken || !sessionToken || !sessionMeta) return;

  const capability = composerCapabilities ? composerCapabilities[sessionMeta.source] : null;
  if (!capability || !capability.enabled) {
    setComposerStatusForSession(sessionId, capability ? capability.note : 'Interaction is not available.', true);
    renderComposer();
    return;
  }

  const normalizedText = typeof text === 'string' ? text : '';
  const outboundText = visibleText == null ? normalizedText : visibleText;
  const outboundImages = Array.isArray(images) ? images.map((attachment) => ({ ...attachment })) : [];
  if (!normalizedText.trim() && outboundImages.length === 0) return;

  const interactionToken = `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  composerLatestInteractionTokenBySession.set(sessionId, interactionToken);
  composerSendingSessions.add(sessionId);
  if (typeof window.__dashboardSetSessionActivityState === 'function') {
    window.__dashboardSetSessionActivityState(sessionId, true, projectToken);
  }
  composerImageStateBySession.delete(sessionId);
  clearComposerActivityEntries(sessionId);
  markAllTransientNotLive(sessionId);
  pushTransientMessageForSession(sessionId, sessionMeta, {
    type: 'user',
    content: formatOutboundUserContent(outboundText, outboundImages.length),
    pending: true,
    live: false,
  });
  clearComposerInput();
  pushComposerActivityEntry(sessionId, 'status', '已发送，等待代理开始...');
  setComposerStatusForSession(sessionId, 'Starting interaction...', false);
  renderComposer();

  const requestState = { createdSession: null, interactionToken, finalizeScheduled: false };

  try {
    const handleEvent = buildStreamEventHandler(sessionId, sessionMeta, requestState, projectToken);
    const controller = new AbortController();
    composerControllersBySession.set(sessionId, controller);
    startSubagentPolling(sessionId, projectToken, sessionToken, sessionMeta, interactionToken);
    const response = await composerFetch(
      `/api/interact/${encodeURIComponent(projectToken)}/${encodeURIComponent(sessionToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          text: normalizedText,
          images: outboundImages,
          sessionMeta,
          claudeProfileOverride: sessionMeta?.source === 'claude' ? currentClaudeProfileOverride() : '',
        }),
      }
    );

    if (!response.ok || !response.body) {
      const responseText = await response.text();
      throw new Error(responseText || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeNdjsonChunk(buffer, handleEvent);
    }

    buffer += decoder.decode();
    consumeNdjsonChunk(buffer, handleEvent);

    setTimeout(() => {
      finalizeComposerHydration(projectToken, sessionId, requestState, interactionToken);
    }, 800);
  } catch (err) {
    stopSubagentPolling(sessionId);
    if (err.name === 'AbortError') {
      await finalizeComposerHydration(projectToken, sessionId, requestState, interactionToken);
      return;
    }
    const message = normalizeComposerErrorMessage(err);
    setComposerStatusForSession(sessionId, message, true);
    pushComposerActivityEntry(sessionId, 'error', `Error: ${message}`);
    if (typeof window.__dashboardMarkSessionNeedsHydration === 'function') {
      window.__dashboardMarkSessionNeedsHydration(sessionId);
    }
    setTimeout(() => {
      finalizeComposerHydration(projectToken, sessionId, requestState, interactionToken);
    }, 600);
  } finally {
    stopSubagentPolling(sessionId);
    composerControllersBySession.delete(sessionId);
    composerSendingSessions.delete(sessionId);
    if (typeof window.__dashboardSetSessionActivityState === 'function') {
      window.__dashboardSetSessionActivityState(sessionId, false, projectToken);
    }
    renderComposer();
  }
}

async function submitComposer() {
  let sessionId = currentSessionId();
  if (typeof window.__dashboardPrepareSessionForNewInteraction === 'function') {
    await window.__dashboardPrepareSessionForNewInteraction(sessionId);
  }

  sessionId = currentSessionId();
  const sessionMeta = currentSessionMeta();
  const projectToken = composerSelection.project;
  const sessionToken = composerSelection.session;
  if (!projectToken || !sessionToken || !sessionMeta) return;

  const textarea = composerEl('composer-input');
  const text = textarea.value;
  if (!text.trim() && composerAttachments.length === 0) return;

  const outboundImages = cloneAttachmentsForRequest();
  clearComposerInput();

  await submitInteraction({
    projectToken,
    sessionId,
    sessionMeta,
    sessionToken,
    text,
    images: outboundImages,
    visibleText: text,
  });
}

function loadComposerCapabilities() {
  return composerFetch('/api/capabilities')
    .then((res) => res.json())
    .then((data) => {
      composerCapabilities = data;
      renderComposer();
      return true;
    })
    .catch((err) => {
      const message = normalizeComposerErrorMessage(err);
      setComposerStatusForSession(currentSessionId(), message, true);
      console.error(err);
      return false;
    });
}

function loadComposerClaudeProfiles(force = false) {
  const now = Date.now();
  if (!force && composerClaudeProfilesPromise) {
    return composerClaudeProfilesPromise;
  }
  if (!force && composerClaudeProfilesLoadedAt && now - composerClaudeProfilesLoadedAt < COMPOSER_CLAUDE_PROFILE_TTL_MS) {
    return Promise.resolve(true);
  }

  composerClaudeProfilesPromise = composerFetch('/api/claude-profiles')
    .then((res) => res.json())
    .then((data) => {
      composerClaudeProfiles = Array.isArray(data) ? data : [];
      composerClaudeProfilesLoadedAt = Date.now();
      renderComposer();
      return true;
    })
    .catch((err) => {
      console.error(err);
      return false;
    })
    .finally(() => {
      composerClaudeProfilesPromise = null;
    });

  return composerClaudeProfilesPromise;
}

function initComposer() {
  const textarea = composerEl('composer-input');
  const sendBtn = composerEl('composer-send');
  const stopBtn = composerEl('composer-stop');
  const uploadBtn = composerEl('composer-upload');
  const uploadInput = composerEl('composer-image-input');
  const activityHeader = composerEl('composer-activity-shell');

  loadComposerCapabilities();
  loadComposerClaudeProfiles();

  document.addEventListener('session:selected', (event) => {
    composerSelection = event.detail || { project: null, session: null, sessionMeta: null };
    composerAttachments = [];
    syncTransientTimelineForSession(currentSessionId());
    if (composerSelection.sessionMeta?.source === 'claude') {
      loadComposerClaudeProfiles();
    }
    renderComposer();
  });

  document.addEventListener('dashboard:backend-health', (event) => {
    if (!event.detail?.healthy) return;
    loadComposerCapabilities();
    loadComposerClaudeProfiles(true);
  });

  window.setInterval(() => {
    if (currentSessionMeta()?.source !== 'claude') return;
    loadComposerClaudeProfiles();
  }, COMPOSER_CLAUDE_PROFILE_TTL_MS);

  if (activityHeader) {
    activityHeader.addEventListener('click', (event) => {
      const removeTarget = event.target.closest('#composer-activity-log');
      if (removeTarget) return;
      if (!getComposerActivityEntries(currentSessionId()).length) return;
      toggleComposerActivityExpanded(currentSessionId());
    });
  }

  uploadBtn.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', async () => {
    await addComposerFiles(uploadInput.files);
    uploadInput.value = '';
  });

  textarea.addEventListener('input', () => {
    renderComposer();
  });

  textarea.addEventListener('paste', async (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const imageFiles = items
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);

    if (imageFiles.length > 0) {
      event.preventDefault();
      await addComposerFiles(imageFiles);
    }
  });

  textarea.addEventListener('keydown', (event) => {
    if (event.isComposing) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitComposer();
    }
  });

  sendBtn.addEventListener('click', submitComposer);
  stopBtn.addEventListener('click', () => {
    stopComposerForSession(currentSessionId(), {
      sessionMeta: currentSessionMeta(),
      projectToken: composerSelection.project,
      message: 'Stopped by user.',
    });
  });

  const selection = window.__dashboardGetSelection ? window.__dashboardGetSelection() : null;
  if (selection) {
    composerSelection = selection;
  }
  renderComposer();
}

window.__dashboardSubmitProgrammaticInteraction = submitInteraction;

document.addEventListener('DOMContentLoaded', initComposer);
