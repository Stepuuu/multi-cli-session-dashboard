// chat-view.js — Conversation/message renderer

const TRUNCATE_THRESHOLD = 5000;
const TOOL_MESSAGE_PREVIEW_LINES = 8;

function escapeAttr(str) {
  return escapeHtml(str);
}

function renderMarkdownLink(label, target) {
  const safeLabel = label;
  const safeTarget = target.trim();
  if (/^https?:\/\//i.test(safeTarget)) {
    return `<a class="msg-link" href="${escapeAttr(safeTarget)}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
  }
  return `<span class="msg-local-link" title="${escapeAttr(safeTarget)}">${safeLabel}</span>`;
}

function formatMarkdownLite(text) {
  const fenceTokens = [];
  const inlineCodeTokens = [];

  let processed = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `@@FENCE_${fenceTokens.length}@@`;
    fenceTokens.push({
      lang: (lang || '').trim(),
      code,
    });
    return token;
  });

  processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `@@INLINE_${inlineCodeTokens.length}@@`;
    inlineCodeTokens.push(code);
    return token;
  });

  processed = escapeHtml(processed);

  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => {
    return renderMarkdownLink(label, target);
  });

  processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  processed = processed.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  processed = processed.replace(/@@INLINE_(\d+)@@/g, (_, index) => {
    const code = inlineCodeTokens[Number(index)] || '';
    return `<code>${escapeHtml(code)}</code>`;
  });

  processed = processed.replace(/@@FENCE_(\d+)@@/g, (_, index) => {
    const block = fenceTokens[Number(index)] || { lang: '', code: '' };
    const cls = block.lang ? ` class="lang-${escapeAttr(block.lang)}"` : '';
    return `<pre><code${cls}>${escapeHtml(block.code)}</code></pre>`;
  });

  return processed;
}

function renderChatHeader(session) {
  const header = document.getElementById('chat-header');
  if (!session) {
    header.innerHTML = '<span>Select a session</span>';
    return;
  }

  const date = session.modified || session.created;
  const dateStr = date ? new Date(date).toLocaleString() : '';
  const branch = session.gitBranch ? `<span class="chat-tag branch">${escapeHtml(session.gitBranch)}</span>` : '';
  const model = session.model ? `<span class="chat-tag model">${escapeHtml(session.model)}</span>` : '';
  const claudeConfig = session.source === 'claude' && session.claudeProfileLabel
    ? `<span class="chat-tag config-tag" title="${escapeHtml(session.claudeConfigSource || '')}${session.claudeProfileHint ? `: ${escapeHtml(session.claudeProfileHint)}` : ''}">${escapeHtml(session.claudeProfileLabel)}</span>`
    : '';
  const sourceLabel = escapeHtml(session.sourceShortLabel || session.sourceLabel || session.source || '?');
  const sourceClass = escapeHtml(session.source || 'unknown');
  const copyButton = `<button class="chat-header-btn" data-chat-action="copy-to-new-cx">New CX From This</button>`;
  const renameButton = `<button class="chat-header-btn" data-chat-action="rename-session">Rename</button>`;
  const pinButton = `<button class="chat-header-btn${window.__dashboardIsPinnedSession && window.__dashboardIsPinnedSession(session.sessionId) ? ' is-active' : ''}" data-chat-action="toggle-pin-session">${window.__dashboardIsPinnedSession && window.__dashboardIsPinnedSession(session.sessionId) ? 'Unpin' : 'Pin'}</button>`;

  header.innerHTML = `
    <div class="chat-header-main">
      <span class="chat-header-title">${escapeHtml(truncate(session.firstPrompt || 'Session', 80))}</span>
      <span class="chat-tag source-tag source-${sourceClass}">${sourceLabel}</span>
      ${claudeConfig}
      <span class="chat-tag">${dateStr}</span>
      ${branch}
      ${model}
    </div>
    <div class="chat-header-actions">
      ${pinButton}
      ${copyButton}
      ${renameButton}
    </div>
  `;
}

function renderMessages(messages, prepend) {
  const container = document.getElementById('chat-messages');

  if (!messages || messages.length === 0) {
    if (!prepend) {
      container.innerHTML = '<div class="empty-state">No messages in this session</div>';
    }
    return;
  }

  const html = renderMessageSequence(messages);

  if (prepend) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const firstChild = container.firstChild;
    while (wrapper.lastChild) {
      container.insertBefore(wrapper.lastChild, firstChild);
    }
  } else {
    container.innerHTML = html;
  }
}

function renderMessageSequence(messages) {
  let previousDayKey = '';
  let html = '';

  for (const msg of messages) {
    const currentDayKey = dayKey(msg.timestamp);
    if (currentDayKey && currentDayKey !== previousDayKey) {
      html += renderDayDivider(msg.timestamp);
      previousDayKey = currentDayKey;
    }
    html += renderMessage(msg);
  }

  return html;
}

function dayKey(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function formatDayLabel(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const todayKey = dayKey(now.toISOString());
  const msgKey = dayKey(timestamp);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth() + 1}-${yesterday.getDate()}`;

  if (msgKey === todayKey) return 'Today';
  if (msgKey === yesterdayKey) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function renderDayDivider(timestamp) {
  const label = escapeHtml(formatDayLabel(timestamp));
  return `
    <div class="day-divider">
      <span class="day-divider-line"></span>
      <span class="day-divider-label">${label}</span>
      <span class="day-divider-line"></span>
    </div>
  `;
}

function renderTimeValue(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderTimeSpan(timestamp) {
  const text = renderTimeValue(timestamp);
  if (!text) return '';
  const title = escapeAttr(new Date(timestamp).toLocaleString());
  return `<span class="msg-time" title="${title}">${text}</span>`;
}

function renderMessage(msg) {
  const type = msg.type || 'system';
  const time = renderTimeSpan(msg.timestamp);
  const model = msg.model ? `<span class="msg-model">${escapeHtml(msg.model)}</span>` : '';

  if (type === 'user') {
    return renderUserMessage(msg, time);
  } else if (type === 'command') {
    return renderCommandMessage(msg, time);
  } else if (type === 'status') {
    return renderStatusMessage(msg, time);
  } else if (type === 'tool_event') {
    return renderToolEventMessage(msg, time);
  } else if (type === 'assistant') {
    return renderAssistantMessage(msg, time, model);
  } else if (type === 'tool_result') {
    return renderToolResultMessage(msg, time);
  } else if (type === 'compact_boundary') {
    return renderCompactBoundary(msg, time);
  } else if (type === 'context_summary') {
    return renderContextSummary(msg, time);
  } else {
    return renderSystemMessage(msg, time);
  }
}

function messageClass(baseClass, msg) {
  const classes = [baseClass];
  if (msg && msg.live) classes.push('live-msg');
  if (msg && msg.pending) classes.push('pending-msg');
  return classes.join(' ');
}

function renderUserMessage(msg, time) {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const bodyHtml = renderTextContent(content);

  return `
    <div class="chat-msg ${messageClass('user-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role user">USER</span>
        ${time}
      </div>
      <div class="msg-body">${bodyHtml}</div>
    </div>
  `;
}

function renderCommandMessage(msg, time) {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const bodyHtml = renderTextContent(content);

  return `
    <div class="chat-msg ${messageClass('command-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role command">COMMAND</span>
        ${time}
      </div>
      <div class="msg-body">${bodyHtml}</div>
    </div>
  `;
}

function renderStatusMessage(msg, time) {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const bodyHtml = renderTextContent(content);

  return `
    <div class="chat-msg ${messageClass('status-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role status">STATUS</span>
        ${time}
      </div>
      <div class="msg-body">${bodyHtml}</div>
    </div>
  `;
}

function renderToolEventMessage(msg, time) {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const bodyHtml = renderCollapsibleTextContent(content, TOOL_MESSAGE_PREVIEW_LINES);

  return `
    <div class="chat-msg ${messageClass('tool-event-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role tool-event">TOOL</span>
        ${time}
      </div>
      <div class="msg-body">${bodyHtml}</div>
    </div>
  `;
}

function renderAssistantMessage(msg, time, modelHtml) {
  let bodyParts = '';
  const roleLabel = escapeHtml(msg.roleLabel || msg.sourceLabel || 'ASSISTANT');

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        bodyParts += renderTextContent(block.text || '');
      } else if (block.type === 'tool_use') {
        bodyParts += renderToolBlock(block);
      } else if (block.type === 'tool_result') {
        bodyParts += renderToolResultBlock(block);
      }
    }
  } else if (typeof msg.content === 'string') {
    bodyParts = renderTextContent(msg.content);
  }

  return `
    <div class="chat-msg ${messageClass('assistant-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role assistant">${roleLabel}</span>
        ${time}
        ${modelHtml}
      </div>
      <div class="msg-body">${bodyParts}</div>
    </div>
  `;
}

function renderToolResultMessage(msg, time) {
  let bodyParts = '';

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        bodyParts += renderToolResultBlock(block);
      }
    }
  } else if (typeof msg.content === 'string') {
    bodyParts = renderCollapsibleTextContent(msg.content, TOOL_MESSAGE_PREVIEW_LINES);
  }

  return `
    <div class="chat-msg ${messageClass('tool-result-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role tool-result">ENV</span>
        ${time}
      </div>
      <div class="msg-body">${bodyParts}</div>
    </div>
  `;
}

function renderCompactBoundary(msg, time) {
  return `
    <div class="chat-msg ${messageClass('compact-boundary-msg', msg)}">
      <div class="compact-divider">
        <span class="compact-line"></span>
        <span class="compact-label">CONTEXT COMPACTED</span>
        ${time ? `<span class="compact-time">${renderTimeValue(msg.timestamp)}</span>` : ''}
        <span class="compact-line"></span>
      </div>
      <div class="compact-note">Messages above this point were summarized to fit context window</div>
    </div>
  `;
}

function renderContextSummary(msg, time) {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const bodyHtml = renderTextContent(content);

  return `
    <div class="chat-msg ${messageClass('context-summary-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role summary">SUMMARY</span>
        ${time}
      </div>
      <div class="msg-body">${bodyHtml}</div>
    </div>
  `;
}

function renderSystemMessage(msg, time) {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  if (!content) return '';
  const bodyHtml = `<div class="msg-text">${escapeHtml(truncate(content, 500))}</div>`;

  return `
    <div class="chat-msg ${messageClass('system-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role system">SYSTEM</span>
        ${time}
      </div>
      <div class="msg-body">${bodyHtml}</div>
    </div>
  `;
}

function renderTextContent(text) {
  if (!text) return '';
  const needsTruncation = text.length > TRUNCATE_THRESHOLD;
  const id = 'trunc-' + Math.random().toString(36).slice(2, 9);

  const processed = formatMarkdownLite(text);

  if (needsTruncation) {
    return `
      <div class="msg-text">
        <div class="truncated-content" id="${id}">${processed}</div>
        <span class="show-more-toggle" onclick="toggleTruncated('${id}', this)">Show more</span>
      </div>
    `;
  }

  return `<div class="msg-text">${processed}</div>`;
}

function renderCollapsibleTextContent(text, maxLines = TOOL_MESSAGE_PREVIEW_LINES) {
  if (!text) return '';
  const lineCount = String(text).split('\n').length;
  const processed = formatMarkdownLite(text);
  if (lineCount <= maxLines) {
    return `<div class="msg-text">${processed}</div>`;
  }

  const id = 'collapse-' + Math.random().toString(36).slice(2, 9);
  return `
    <div class="msg-text">
      <div class="collapsible-content" id="${id}" style="--preview-lines:${maxLines}">${processed}</div>
      <span class="show-more-toggle" onclick="toggleCollapsedBlock('${id}', this)">Expand</span>
    </div>
  `;
}

function renderToolBlock(block) {
  const name = escapeHtml(block.name || 'Tool');
  let inputStr = '';
  if (typeof block.input === 'string') {
    inputStr = block.input;
  } else if (block.input && typeof block.input === 'object') {
    // Show the most relevant field as summary
    const summary = block.input.command || block.input.pattern || block.input.file_path || block.input.query || block.input.content || '';
    inputStr = typeof summary === 'string' ? summary : JSON.stringify(block.input, null, 2);
  }

  const summaryText = escapeHtml(truncate(inputStr.split('\n')[0], 80));
  const detailText = escapeHtml(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));

  return `
    <div class="tool-block" onclick="this.classList.toggle('expanded')">
      <div class="tool-header">
        <span class="tool-badge">${name}</span>
        <span class="tool-summary">${summaryText}</span>
        <span class="tool-toggle">&#9654;</span>
      </div>
      <pre class="tool-detail">${detailText}</pre>
    </div>
  `;
}

function renderToolResultBlock(block) {
  let content = '';
  if (typeof block.content === 'string') {
    content = block.content;
  } else if (Array.isArray(block.content)) {
    content = block.content.map(c => c.text || JSON.stringify(c)).join('\n');
  } else {
    content = JSON.stringify(block.content, null, 2);
  }

  const summaryText = escapeHtml(truncate(content.split('\n')[0], 80));
  const detailText = escapeHtml(content);

  return `
    <div class="tool-block" onclick="this.classList.toggle('expanded')">
      <div class="tool-header">
        <span class="tool-badge">Result</span>
        <span class="tool-summary">${summaryText}</span>
        <span class="tool-toggle">&#9654;</span>
      </div>
      <pre class="tool-detail">${detailText}</pre>
    </div>
  `;
}

function toggleTruncated(id, toggleEl) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('expanded');
  toggleEl.textContent = el.classList.contains('expanded') ? 'Show less' : 'Show more';
}

function toggleCollapsedBlock(id, toggleEl) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('expanded');
  toggleEl.textContent = el.classList.contains('expanded') ? 'Collapse' : 'Expand';
}

function renderLoadMoreButton(hasMore) {
  const container = document.getElementById('chat-messages');
  // Remove existing load more button
  const existing = container.querySelector('.load-more-btn');
  if (existing) existing.remove();

  if (hasMore) {
    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = '[ Load earlier messages ]';
    btn.addEventListener('click', () => {
      if (typeof loadMoreMessages === 'function') loadMoreMessages();
    });
    container.insertBefore(btn, container.firstChild);
  }
}
