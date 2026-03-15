// composer.js — Interactive prompt composer for selected sessions

let composerCapabilities = null;
let composerAttachments = [];
let composerSending = false;
let composerStatus = 'Idle';
let composerSelection = { project: null, session: null, sessionMeta: null };
let composerTransientMessages = [];
let composerTransientCounter = 0;
const COMPOSER_MAX_HEIGHT = 260;
let composerCreatedSession = null;

function composerEl(id) {
  return document.getElementById(id);
}

function currentCapability() {
  const source = composerSelection.sessionMeta && composerSelection.sessionMeta.source;
  return source && composerCapabilities ? composerCapabilities[source] : null;
}

function autoResizeComposer() {
  const textarea = composerEl('composer-input');
  if (!textarea) return;

  textarea.style.height = 'auto';
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, 92), COMPOSER_MAX_HEIGHT);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
}

function setComposerStatus(text, isError) {
  composerStatus = text || 'Idle';
  const statusEl = composerEl('composer-status');
  if (!statusEl) return;
  statusEl.textContent = composerStatus;
  statusEl.classList.toggle('is-error', !!isError);
}

function syncTransientTimeline() {
  if (typeof window.__dashboardSetTransientMessages === 'function') {
    window.__dashboardSetTransientMessages(composerTransientMessages);
  }
}

function resetTransientTimeline() {
  composerTransientMessages = [];
  syncTransientTimeline();
}

function nextTransientId() {
  composerTransientCounter += 1;
  return `composer-tmp-${composerTransientCounter}`;
}

function markAllTransientNotLive() {
  composerTransientMessages = composerTransientMessages.map((msg) => ({ ...msg, live: false }));
}

function pushTransientMessage(message) {
  const transientMessage = {
    timestamp: new Date().toISOString(),
    source: composerSelection.sessionMeta ? composerSelection.sessionMeta.source : '',
    sourceLabel: composerSelection.sessionMeta ? composerSelection.sessionMeta.sourceLabel : '',
    sourceShortLabel: composerSelection.sessionMeta ? composerSelection.sessionMeta.sourceShortLabel : '',
    ...message,
    _transientId: message._transientId || nextTransientId(),
  };
  composerTransientMessages = [...composerTransientMessages, transientMessage];
  syncTransientTimeline();
  return transientMessage._transientId;
}

function updateTransientMessage(id, patch) {
  composerTransientMessages = composerTransientMessages.map((msg) => (
    msg._transientId === id ? { ...msg, ...patch } : msg
  ));
  syncTransientTimeline();
}

function ensureLiveAssistantMessage() {
  const existing = composerTransientMessages.find((msg) => msg._transientKind === 'assistant-live');
  if (existing) return existing._transientId;

  markAllTransientNotLive();
  return pushTransientMessage({
    type: 'assistant',
    roleLabel: (
      composerSelection.sessionMeta &&
      (composerSelection.sessionMeta.sourceLabel || composerSelection.sessionMeta.sourceShortLabel)
    ) || 'ASSISTANT',
    content: '正在回复...',
    live: true,
    pending: true,
    _transientKind: 'assistant-live',
  });
}

function pushLiveStatusMessage(text, isError, type = 'status') {
  markAllTransientNotLive();
  return pushTransientMessage({
    type,
    content: text,
    live: true,
    pending: !isError,
    _transientKind: isError ? 'status-error' : `${type}-live`,
  });
}

function finalizeLiveMessages() {
  composerTransientMessages = composerTransientMessages.map((msg) => ({
    ...msg,
    live: false,
    pending: false,
  }));
  syncTransientTimeline();
}

function resetComposerAttachments() {
  composerAttachments = [];
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

  container.innerHTML = composerAttachments.map((attachment, index) => `
    <div class="composer-attachment">
      <img src="${escapeHtml(attachment.dataUrl)}" alt="${escapeHtml(attachment.name)}" class="composer-attachment-thumb">
      <div class="composer-attachment-meta">
        <span class="composer-attachment-name">${escapeHtml(attachment.name)}</span>
        <span class="composer-attachment-type">${escapeHtml(attachment.type)}</span>
      </div>
      <button class="composer-attachment-remove" data-index="${index}" ${composerSending ? 'disabled' : ''}>×</button>
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
  const uploadBtn = composerEl('composer-upload');
  const metaEl = composerEl('composer-meta');
  const capability = currentCapability();
  const selected = !!(composerSelection.project && composerSelection.session && composerSelection.sessionMeta);
  const enabled = selected && capability && capability.enabled && !composerSending;

  if (!selected) {
    metaEl.textContent = 'Select a session to start interacting.';
  } else if (!capability) {
    metaEl.textContent = 'Loading capabilities...';
  } else {
    metaEl.textContent = capability.note;
  }

  textarea.disabled = !enabled;
  sendBtn.disabled = !enabled || (!textarea.value.trim() && composerAttachments.length === 0);
  uploadBtn.disabled = !enabled;
  sendBtn.textContent = composerSending ? 'Sending...' : 'Send';
  textarea.placeholder = capability && capability.directImages
    ? 'Type a message. Images will be attached directly.'
    : 'Type a message. Images will be saved locally and referenced in the prompt.';

  renderAttachments();
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
  if (composerSending) return;

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

function applyStreamEvent(event) {
  if (event.type === 'status') {
    setComposerStatus(event.message || 'Working...', false);
    pushLiveStatusMessage(event.message || 'Working...', false, 'status');
    return;
  }

  if (event.type === 'meta') {
    const sourceLabel = (
      composerSelection.sessionMeta &&
      (composerSelection.sessionMeta.sourceLabel || composerSelection.sessionMeta.sourceShortLabel)
    ) || event.source;
    setComposerStatus(`Connected to ${sourceLabel}`, false);
    return;
  }

  if (event.type === 'session_created') {
    composerCreatedSession = {
      source: event.source,
      rawSessionId: event.rawSessionId,
    };
    return;
  }

  if (event.type === 'tool_event') {
    setComposerStatus(event.message || 'Tool running...', false);
    pushLiveStatusMessage(event.message || 'Tool running...', false, 'tool_event');
    return;
  }

  if (event.type === 'assistant_delta') {
    setComposerStatus('正在回复...', false);
    const messageId = ensureLiveAssistantMessage();
    const current = composerTransientMessages.find((msg) => msg._transientId === messageId);
    const currentText = typeof current?.content === 'string' && current.content !== '正在回复...'
      ? current.content
      : '';
    updateTransientMessage(messageId, {
      content: currentText + (event.text || ''),
      live: true,
      pending: true,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (event.type === 'assistant_final') {
    setComposerStatus('已收到回复', false);
    const existing = composerTransientMessages.find((msg) => msg._transientKind === 'assistant-live');
    if (existing) {
      updateTransientMessage(existing._transientId, {
        content: event.text || existing.content,
        live: false,
        pending: false,
        timestamp: new Date().toISOString(),
      });
    } else {
      pushTransientMessage({
        type: 'assistant',
        roleLabel: (
          composerSelection.sessionMeta &&
          (composerSelection.sessionMeta.sourceLabel || composerSelection.sessionMeta.sourceShortLabel)
        ) || 'ASSISTANT',
        content: event.text || '',
        live: false,
        pending: false,
      });
    }
    return;
  }

  if (event.type === 'error') {
    setComposerStatus(event.message || 'Interaction failed.', true);
    pushLiveStatusMessage(`Error: ${event.message || 'Interaction failed.'}`, true);
    return;
  }

  if (event.type === 'done') {
    finalizeLiveMessages();
    setComposerStatus('Done', false);
  }
}

async function submitComposer() {
  if (composerSending) return;
  if (!composerSelection.project || !composerSelection.session || !composerSelection.sessionMeta) return;

  const capability = currentCapability();
  if (!capability || !capability.enabled) {
    setComposerStatus(capability ? capability.note : 'Interaction is not available.', true);
    return;
  }

  const textarea = composerEl('composer-input');
  const text = textarea.value.trim();
  if (!text && composerAttachments.length === 0) return;

  const outboundText = textarea.value;
  composerSending = true;
  composerCreatedSession = null;
  resetTransientTimeline();
  pushTransientMessage({
    type: 'user',
    content: outboundText,
    pending: true,
    live: false,
  });
  clearComposerInput();
  pushLiveStatusMessage('已发送，等待代理开始...', false);
  setComposerStatus('Starting interaction...', false);
  renderComposer();

  try {
    const response = await fetch(
      `/api/interact/${encodeURIComponent(composerSelection.project)}/${encodeURIComponent(composerSelection.session)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          images: composerAttachments,
        }),
      }
    );

    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeNdjsonChunk(buffer, applyStreamEvent);
    }

    buffer += decoder.decode();
    consumeNdjsonChunk(buffer, applyStreamEvent);
    setTimeout(() => {
      if (
        composerCreatedSession &&
        typeof window.__dashboardReloadSessionsAndSelect === 'function'
      ) {
        window.__dashboardReloadSessionsAndSelect(composerSelection.project, composerCreatedSession);
      } else if (typeof window.reloadCurrentSession === 'function') {
        window.reloadCurrentSession();
      }
    }, 800);
  } catch (err) {
    setComposerStatus(err.message || 'Interaction failed.', true);
    pushLiveStatusMessage(`Error: ${err.message || 'Interaction failed.'}`, true);
  } finally {
    composerSending = false;
    renderComposer();
  }
}

function initComposer() {
  const textarea = composerEl('composer-input');
  const sendBtn = composerEl('composer-send');
  const uploadBtn = composerEl('composer-upload');
  const uploadInput = composerEl('composer-image-input');

  fetch('/api/capabilities')
    .then((res) => res.json())
    .then((data) => {
      composerCapabilities = data;
      renderComposer();
    })
    .catch((err) => {
      setComposerStatus('Failed to load interaction capabilities.', true);
      console.error(err);
    });

  document.addEventListener('session:selected', (event) => {
    composerSelection = event.detail || { project: null, session: null, sessionMeta: null };
    composerCreatedSession = null;
    resetTransientTimeline();
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

  const selection = window.__dashboardGetSelection ? window.__dashboardGetSelection() : null;
  if (selection) {
    composerSelection = selection;
  }
  renderComposer();
}

document.addEventListener('DOMContentLoaded', initComposer);
