// composer.js — Interactive prompt composer for selected sessions

let composerCapabilities = null;
let composerAttachments = [];
let composerSelection = { project: null, session: null, sessionMeta: null };
let composerTransientCounter = 0;
const COMPOSER_MAX_HEIGHT = 260;

const composerSendingSessions = new Set();
const composerStatusBySession = new Map();
const composerTransientMessagesBySession = new Map();
const composerImageStateBySession = new Map();
const composerControllersBySession = new Map();

function composerEl(id) {
  return document.getElementById(id);
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

function nextTransientId() {
  composerTransientCounter += 1;
  return `composer-tmp-${composerTransientCounter}`;
}

function markAllTransientNotLive(sessionId) {
  const next = getTransientMessages(sessionId).map((msg) => ({ ...msg, live: false }));
  composerTransientMessagesBySession.set(sessionId, next);
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
  const next = getTransientMessages(sessionId).map((msg) => (
    msg._transientId === id ? { ...msg, ...patch } : msg
  ));
  composerTransientMessagesBySession.set(sessionId, next);
  syncTransientTimelineForSession(sessionId);
}

function ensureLiveAssistantMessage(sessionId, sessionMeta) {
  const existing = getTransientMessages(sessionId).find((msg) => msg._transientKind === 'assistant-live');
  if (existing) return existing._transientId;

  markAllTransientNotLive(sessionId);
  return pushTransientMessageForSession(sessionId, sessionMeta, {
    type: 'assistant',
    roleLabel: (sessionMeta && (sessionMeta.sourceLabel || sessionMeta.sourceShortLabel)) || 'ASSISTANT',
    content: '正在回复...',
    live: true,
    pending: true,
    _transientKind: 'assistant-live',
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
  renderImageStateBar();
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

function buildStreamEventHandler(sessionId, sessionMeta, requestState) {
  return function applyStreamEvent(event) {
    if (event.type === 'status') {
      setComposerStatusForSession(sessionId, event.message || 'Working...', false);
      pushLiveStatusMessage(sessionId, sessionMeta, event.message || 'Working...', false, 'status');
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
      pushLiveStatusMessage(sessionId, sessionMeta, event.message || 'Tool running...', false, 'tool_event');
      return;
    }

    if (event.type === 'tool_result') {
      setComposerStatusForSession(sessionId, 'Tool completed.', false);
      markAllTransientNotLive(sessionId);
      pushTransientMessageForSession(sessionId, sessionMeta, {
        type: 'tool_result',
        content: event.message || '',
        live: false,
        pending: false,
        _transientKind: 'tool-result',
      });
      return;
    }

    if (event.type === 'assistant_delta') {
      setComposerStatusForSession(sessionId, '正在回复...', false);
      const messageId = ensureLiveAssistantMessage(sessionId, sessionMeta);
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
      const existing = getTransientMessages(sessionId).find((msg) => msg._transientKind === 'assistant-live');
      if (existing) {
        updateTransientMessageForSession(sessionId, existing._transientId, {
          content: event.text || existing.content,
          live: false,
          pending: false,
          timestamp: new Date().toISOString(),
        });
      } else {
        pushTransientMessageForSession(sessionId, sessionMeta, {
          type: 'assistant',
          roleLabel: (sessionMeta && (sessionMeta.sourceLabel || sessionMeta.sourceShortLabel)) || 'ASSISTANT',
          content: event.text || '',
          live: false,
          pending: false,
        });
      }
      return;
    }

    if (event.type === 'error') {
      setComposerStatusForSession(sessionId, event.message || 'Interaction failed.', true);
      pushLiveStatusMessage(sessionId, sessionMeta, `Error: ${event.message || 'Interaction failed.'}`, true);
      return;
    }

    if (event.type === 'done') {
      finalizeLiveMessages(sessionId);
      setComposerStatusForSession(sessionId, 'Done', false);
      if (typeof window.__dashboardMarkSessionNeedsHydration === 'function') {
        window.__dashboardMarkSessionNeedsHydration(sessionId);
      }
    }
  }
}

function stopComposerForSession(sessionId, options = {}) {
  const controller = composerControllersBySession.get(sessionId);
  if (!controller) return false;

  composerControllersBySession.delete(sessionId);
  composerSendingSessions.delete(sessionId);
  if (typeof window.__dashboardSetSessionActivityState === 'function') {
    window.__dashboardSetSessionActivityState(sessionId, false, options.projectToken || '');
  }
  setComposerStatusForSession(sessionId, options.message || 'Stopped.', false);
  markAllTransientNotLive(sessionId);
  pushTransientMessageForSession(sessionId, options.sessionMeta || currentSessionMeta(), {
    type: 'status',
    content: options.message || 'Stopped.',
    live: false,
    pending: false,
    _transientKind: 'status-stopped',
  });
  renderComposer();
  controller.abort();
  return true;
}

async function finalizeComposerHydration(projectToken, sessionId, requestState) {
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

  composerSendingSessions.add(sessionId);
  if (typeof window.__dashboardSetSessionActivityState === 'function') {
    window.__dashboardSetSessionActivityState(sessionId, true, projectToken);
  }
  composerImageStateBySession.delete(sessionId);
  resetTransientTimelineForSession(sessionId);
  pushTransientMessageForSession(sessionId, sessionMeta, {
    type: 'user',
    content: formatOutboundUserContent(outboundText, outboundImages.length),
    pending: true,
    live: false,
  });
  clearComposerInput();
  pushLiveStatusMessage(sessionId, sessionMeta, '已发送，等待代理开始...', false);
  setComposerStatusForSession(sessionId, 'Starting interaction...', false);
  renderComposer();

  const requestState = { createdSession: null };

  try {
    const handleEvent = buildStreamEventHandler(sessionId, sessionMeta, requestState);
    const controller = new AbortController();
    composerControllersBySession.set(sessionId, controller);
    const response = await fetch(
      `/api/interact/${encodeURIComponent(projectToken)}/${encodeURIComponent(sessionToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          text: normalizedText,
          images: outboundImages,
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
      finalizeComposerHydration(projectToken, sessionId, requestState);
    }, 800);
  } catch (err) {
    if (err.name === 'AbortError') {
      await finalizeComposerHydration(projectToken, sessionId, requestState);
      return;
    }
    setComposerStatusForSession(sessionId, err.message || 'Interaction failed.', true);
    pushLiveStatusMessage(sessionId, sessionMeta, `Error: ${err.message || 'Interaction failed.'}`, true);
    if (typeof window.__dashboardMarkSessionNeedsHydration === 'function') {
      window.__dashboardMarkSessionNeedsHydration(sessionId);
    }
    setTimeout(() => {
      finalizeComposerHydration(projectToken, sessionId, requestState);
    }, 600);
  } finally {
    composerControllersBySession.delete(sessionId);
    composerSendingSessions.delete(sessionId);
    if (typeof window.__dashboardSetSessionActivityState === 'function') {
      window.__dashboardSetSessionActivityState(sessionId, false, projectToken);
    }
    renderComposer();
  }
}

async function submitComposer() {
  const sessionId = currentSessionId();
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

function initComposer() {
  const textarea = composerEl('composer-input');
  const sendBtn = composerEl('composer-send');
  const stopBtn = composerEl('composer-stop');
  const uploadBtn = composerEl('composer-upload');
  const uploadInput = composerEl('composer-image-input');

  fetch('/api/capabilities')
    .then((res) => res.json())
    .then((data) => {
      composerCapabilities = data;
      renderComposer();
    })
    .catch((err) => {
      setComposerStatusForSession(currentSessionId(), 'Failed to load interaction capabilities.', true);
      console.error(err);
    });

  document.addEventListener('session:selected', (event) => {
    composerSelection = event.detail || { project: null, session: null, sessionMeta: null };
    composerAttachments = [];
    renderComposer();
  });

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
