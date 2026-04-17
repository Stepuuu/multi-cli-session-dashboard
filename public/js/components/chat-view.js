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
  const cacheInfo = typeof window.__dashboardSessionCacheInfo === 'function'
    ? window.__dashboardSessionCacheInfo(session)
    : null;
  const cacheTooltip = typeof window.__dashboardBuildSessionCacheTooltip === 'function'
    ? window.__dashboardBuildSessionCacheTooltip(session)
    : '';
  const cacheTag = cacheInfo
    ? `<span class="chat-tag cache-tag" title="${escapeAttr(cacheTooltip)}">CACHE ${cacheInfo.percent}%</span>`
    : '';
  const archivedTag = session.archived
    ? '<span class="chat-tag archived-tag" title="Archived in VS Code Codex">ARCHIVED</span>'
    : '';
  const forkTooltip = typeof window.__dashboardBuildSessionForkTooltip === 'function'
    ? window.__dashboardBuildSessionForkTooltip(session)
    : '';
  const forkTag = session.forkedFromId
    ? `<span class="chat-tag fork-tag" title="${escapeAttr(forkTooltip || `Forked from ${session.forkedFromId}`)}">FROM ${escapeHtml(session.forkedFromId)}</span>`
    : '';
  const fileSizeLabel = typeof window.__dashboardSessionFileSizeLabel === 'function'
    ? window.__dashboardSessionFileSizeLabel(session)
    : '';
  const fileSizeTooltip = typeof window.__dashboardSessionFileSizeTooltip === 'function'
    ? window.__dashboardSessionFileSizeTooltip(session)
    : '';
  const fileSizeTag = fileSizeLabel
    ? `<span class="chat-tag file-tag" title="${escapeAttr(fileSizeTooltip || fileSizeLabel)}">${escapeHtml(fileSizeLabel)}</span>`
    : '';
  const contextInfo = typeof window.__dashboardSessionContextInfo === 'function'
    ? window.__dashboardSessionContextInfo(session)
    : null;
  const contextTooltip = typeof window.__dashboardBuildSessionContextTooltip === 'function'
    ? window.__dashboardBuildSessionContextTooltip(session)
    : '';
  const contextBar = contextInfo
    ? `<span class="chat-context-bar" title="${escapeAttr(contextTooltip)}"><span class="chat-context-bar-fill" style="width:${Math.max(2, contextInfo.percent)}%"></span></span>`
    : '';
  const sourceLabel = escapeHtml(session.sourceShortLabel || session.sourceLabel || session.source || '?');
  const sourceClass = escapeHtml(session.source || 'unknown');
  const titleTooltip = typeof window.__dashboardBuildSessionTitleTooltip === 'function'
    ? window.__dashboardBuildSessionTitleTooltip(session)
    : (session.firstPrompt || 'Session');
  const copyButton = `<button class="chat-header-btn" data-chat-action="copy-to-new-cx">New CX From This</button>`;
  const renameButton = `<button class="chat-header-btn" data-chat-action="rename-session">Rename</button>`;
  const pinButton = `<button class="chat-header-btn${window.__dashboardIsPinnedSession && window.__dashboardIsPinnedSession(session.sessionId) ? ' is-active' : ''}" data-chat-action="toggle-pin-session">${window.__dashboardIsPinnedSession && window.__dashboardIsPinnedSession(session.sessionId) ? 'Unpin' : 'Pin'}</button>`;

  header.innerHTML = `
    <div class="chat-header-main">
      <span class="chat-header-title" title="${escapeAttr(titleTooltip)}">${escapeHtml(truncate(session.firstPrompt || 'Session', 80))}</span>
      <span class="chat-tag source-tag source-${sourceClass}">${sourceLabel}</span>
      ${forkTag}
      ${fileSizeTag}
      ${claudeConfig}
      ${cacheTag}
      ${archivedTag}
      <span class="chat-tag">${dateStr}</span>
      ${branch}
      ${model}
      ${contextBar}
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
  } else if (type === 'tool_activity') {
    return renderToolActivityMessage(msg, time);
  } else if (type === 'subagent_group') {
    return renderSubagentGroupMessage(msg, time);
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
  const bodyHtml = (msg.toolName || msg.command || (Array.isArray(msg.changes) && msg.changes.length))
    ? renderToolBlock({
      name: msg.toolName || 'tool',
      summary: msg.summary || '',
      input: msg.command || msg.content || '',
      command: msg.command || '',
      changes: msg.changes || [],
    })
    : renderCollapsibleTextContent(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      TOOL_MESSAGE_PREVIEW_LINES,
    );

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

function formatToolDisplayName(name) {
  if (!name) return 'Tool';
  return String(name)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function buildToolActivityRoleLabel(msg) {
  if (msg.toolName === 'apply_patch' || (Array.isArray(msg.changes) && msg.changes.length)) {
    return 'EDITED';
  }
  if (msg.toolName === 'exec_command') {
    return 'RAN';
  }
  if (msg.toolName === 'web_search') {
    return 'SEARCHED';
  }
  return 'TOOL';
}

function renderToolActivityMessage(msg, time) {
  const block = {
    name: formatToolDisplayName(msg.toolName || 'tool'),
    summary: msg.summary || '',
    input: msg.input ?? null,
    command: msg.command || '',
    content: msg.output ?? '',
    changes: msg.changes || [],
    exitCode: msg.exitCode,
    isError: !!msg.isError,
  };
  const summaryText = escapeHtml(buildToolSummary(block, block.name));
  const detailHtml = renderToolDetailSections(block, {
    result: true,
    includeInput: true,
    outputLabel: block.isError ? 'Error' : 'Output',
  });
  const roleLabel = buildToolActivityRoleLabel(msg);

  return `
    <div class="chat-msg ${messageClass('tool-activity-msg', msg)}">
      <div class="msg-header">
        <span class="msg-role tool-event">${escapeHtml(roleLabel)}</span>
        ${time}
      </div>
      <div class="msg-body">
        <div class="tool-block${block.isError ? ' tool-block-error' : ''}" onclick="this.classList.toggle('expanded')">
          <div class="tool-header">
            <span class="tool-badge">${escapeHtml(block.name)}</span>
            <span class="tool-summary">${summaryText}</span>
            ${renderToolMetaBadges(block)}
            <span class="tool-toggle">&#9654;</span>
          </div>
          <div class="tool-detail">${detailHtml}</div>
        </div>
      </div>
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
      } else if (block.type === 'thinking') {
        bodyParts += renderThinkingBlock(block);
      } else if (block.type === 'redacted_thinking') {
        bodyParts += renderThinkingBlock(block, true);
      } else if (block.type === 'tool_use') {
        bodyParts += renderToolBlock(block);
      } else if (block.type === 'tool_result') {
        bodyParts += renderToolResultBlock(block);
      }
    }
  } else if (typeof msg.content === 'string') {
    bodyParts = renderTextContent(msg.content);
  }

  if (!bodyParts) return '';

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

  if (msg.toolName || msg.command || msg.exitCode != null || (Array.isArray(msg.changes) && msg.changes.length)) {
    bodyParts = renderToolResultBlock({
      type: 'tool_result',
      content: msg.aggregatedOutput || msg.content || '',
      summary: msg.summary || '',
      command: msg.command || '',
      exitCode: msg.exitCode,
      changes: msg.changes || [],
      isError: !!msg.isError,
    });
  } else if (Array.isArray(msg.content)) {
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

function formatDurationMs(ms) {
  const numeric = Number(ms || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  if (numeric < 1000) return `${numeric}ms`;
  const seconds = numeric / 1000;
  if (seconds < 60) return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = Math.round(seconds % 60);
  return `${minutes}m ${remain}s`;
}

function renderSubagentGroupMessage(msg, time) {
  const subagent = msg.subagent || {};
  const name = escapeHtml(subagent.nickname || subagent.role || subagent.rawSessionId || 'subagent');
  const role = subagent.role ? `<span class="subagent-chip">${escapeHtml(subagent.role)}</span>` : '';
  const depth = Number.isFinite(Number(subagent.depth)) && Number(subagent.depth) > 0
    ? `<span class="subagent-chip">depth ${escapeHtml(String(subagent.depth))}</span>`
    : '';
  const status = subagent.status ? `<span class="subagent-chip status-${escapeHtml(subagent.status)}">${escapeHtml(subagent.status)}</span>` : '';
  const totalMessages = Number(msg.totalMessages || msg.messageCount || (Array.isArray(msg.messages) ? msg.messages.length : 0) || 0);
  const duration = formatDurationMs(subagent.durationMs || 0);
  const summary = msg.summary
    ? `<div class="subagent-summary">${renderTextContent(msg.summary)}</div>`
    : '';
  const note = msg.hasMoreMessages
    ? `<div class="subagent-note">Showing latest ${escapeHtml(String((msg.messages || []).length))} of ${escapeHtml(String(totalMessages))} child messages</div>`
    : '';
  const nestedHtml = Array.isArray(msg.messages) && msg.messages.length
    ? renderMessageSequence(msg.messages)
    : '<div class="subagent-empty">No transcript captured.</div>';

  return `
    <div class="chat-msg ${messageClass('subagent-msg', msg)}">
      <div class="subagent-group">
        <div class="subagent-header" onclick="toggleSubagentGroup(this.parentElement)">
          <span class="subagent-title">@${name}</span>
          ${role}
          ${depth}
          ${status}
          <span class="subagent-meta">${escapeHtml(String(totalMessages))} msgs${duration ? ` · ${escapeHtml(duration)}` : ''}</span>
          ${time}
          <span class="subagent-toggle">&#9654;</span>
        </div>
        <div class="subagent-body">
          ${summary}
          ${note}
          <div class="subagent-thread">${nestedHtml}</div>
        </div>
      </div>
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

function normalizeDiffSourceText(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (normalized.startsWith('apply_patch\n*** Begin Patch')) {
    return normalized.slice('apply_patch\n'.length);
  }
  return normalized;
}

function classifyApplyPatchLine(line) {
  if (line === '*** End of File') {
    return { kind: 'meta', prefix: '', text: line };
  }
  if (!line) {
    return { kind: 'context', prefix: ' ', text: '' };
  }
  if (line.startsWith('+')) {
    return { kind: 'add', prefix: '+', text: line.slice(1) };
  }
  if (line.startsWith('-')) {
    return { kind: 'remove', prefix: '-', text: line.slice(1) };
  }
  if (line.startsWith(' ')) {
    return { kind: 'context', prefix: ' ', text: line.slice(1) };
  }
  return { kind: 'meta', prefix: '', text: line };
}

function countDiffStatsFromLines(lines) {
  let additions = 0;
  let removals = 0;
  for (const line of lines || []) {
    if (line.kind === 'add') additions += 1;
    if (line.kind === 'remove') removals += 1;
  }
  return { additions, removals };
}

function finalizeDiffFile(file) {
  const allLines = (file.hunks || []).flatMap((hunk) => hunk.lines || []);
  const stats = countDiffStatsFromLines(allLines);
  return {
    ...file,
    stats,
  };
}

function parseApplyPatchDiff(text) {
  const normalized = normalizeDiffSourceText(text);
  const lines = normalized.split('\n');
  let index = 0;

  while (index < lines.length && !lines[index].trim()) index += 1;
  if (lines[index] !== '*** Begin Patch') return null;
  index += 1;

  const files = [];
  let currentFile = null;
  let currentHunk = null;

  function pushCurrentFile() {
    if (!currentFile) return;
    files.push(finalizeDiffFile(currentFile));
    currentFile = null;
    currentHunk = null;
  }

  function ensureHunk(header = '') {
    if (!currentFile) return null;
    if (!currentHunk) {
      currentHunk = { header, lines: [] };
      currentFile.hunks.push(currentHunk);
    } else if (header) {
      currentHunk = { header, lines: [] };
      currentFile.hunks.push(currentHunk);
    }
    return currentHunk;
  }

  while (index < lines.length) {
    const line = lines[index];

    if (line === '*** End Patch') {
      pushCurrentFile();
      const stats = {
        additions: files.reduce((sum, file) => sum + (file.stats?.additions || 0), 0),
        removals: files.reduce((sum, file) => sum + (file.stats?.removals || 0), 0),
      };
      return {
        format: 'apply_patch',
        files,
        stats,
      };
    }

    if (line.startsWith('*** Add File: ')) {
      pushCurrentFile();
      currentFile = {
        kind: 'add',
        oldPath: '',
        newPath: line.slice('*** Add File: '.length),
        displayPath: line.slice('*** Add File: '.length),
        hunks: [],
      };
      currentHunk = { header: 'new file', lines: [] };
      currentFile.hunks.push(currentHunk);
      index += 1;
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      pushCurrentFile();
      currentFile = {
        kind: 'delete',
        oldPath: line.slice('*** Delete File: '.length),
        newPath: '',
        displayPath: line.slice('*** Delete File: '.length),
        hunks: [],
      };
      currentHunk = null;
      index += 1;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      pushCurrentFile();
      const oldPath = line.slice('*** Update File: '.length);
      currentFile = {
        kind: 'update',
        oldPath,
        newPath: oldPath,
        displayPath: oldPath,
        hunks: [],
      };
      currentHunk = null;
      index += 1;
      continue;
    }

    if (line.startsWith('*** Move to: ') && currentFile) {
      currentFile.kind = 'move';
      currentFile.newPath = line.slice('*** Move to: '.length);
      currentFile.displayPath = `${currentFile.oldPath} -> ${currentFile.newPath}`;
      index += 1;
      continue;
    }

    if (line === '*** End of File' && currentFile) {
      ensureHunk();
      currentHunk.lines.push({ kind: 'meta', prefix: '', text: line });
      index += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      ensureHunk(line);
      index += 1;
      continue;
    }

    if (currentFile) {
      ensureHunk();
      currentHunk.lines.push(classifyApplyPatchLine(line));
      index += 1;
      continue;
    }

    return null;
  }

  return null;
}

function classifyGenericDiffLine(line) {
  if (/^(diff --git|index |--- |\+\+\+|@@)/.test(line)) {
    return { kind: 'meta', prefix: '', text: line };
  }
  if (/^\+[^+]/.test(line)) {
    return { kind: 'add', prefix: '+', text: line.slice(1) };
  }
  if (/^-[^-]/.test(line)) {
    return { kind: 'remove', prefix: '-', text: line.slice(1) };
  }
  return { kind: 'context', prefix: ' ', text: line };
}

function parseRenderableDiff(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const applyPatch = parseApplyPatchDiff(text);
  if (applyPatch) return applyPatch;

  const normalized = normalizeDiffSourceText(text);
  if (!looksLikeDiff(normalized)) return null;

  const lines = normalized.split('\n').map(classifyGenericDiffLine);
  return {
    format: 'generic',
    lines,
    stats: countDiffStatsFromLines(lines),
  };
}

function buildDiffSummary(diff) {
  if (!diff) return '';
  if (diff.format === 'apply_patch') {
    const files = diff.files || [];
    const additions = files.reduce((sum, file) => sum + (file.stats?.additions || 0), 0);
    const removals = files.reduce((sum, file) => sum + (file.stats?.removals || 0), 0);
    if (files.length === 1) {
      const file = files[0];
      const pathLabel = file.displayPath || file.newPath || file.oldPath || 'file';
      const verb = file.kind === 'add'
        ? 'Add'
        : file.kind === 'delete'
          ? 'Delete'
          : file.kind === 'move'
            ? 'Move'
            : 'Update';
      const counts = [];
      if (additions > 0) counts.push(`+${additions}`);
      if (removals > 0) counts.push(`-${removals}`);
      return `${verb} ${pathLabel}${counts.length ? ` · ${counts.join(' ')}` : ''}`;
    }
    const counts = [];
    if (additions > 0) counts.push(`+${additions}`);
    if (removals > 0) counts.push(`-${removals}`);
    return `${files.length} files changed${counts.length ? ` · ${counts.join(' ')}` : ''}`;
  }

  if (diff.format === 'generic') {
    const additions = diff.stats?.additions || 0;
    const removals = diff.stats?.removals || 0;
    const counts = [];
    if (additions > 0) counts.push(`+${additions}`);
    if (removals > 0) counts.push(`-${removals}`);
    return counts.length ? `Diff output · ${counts.join(' ')}` : 'Diff output';
  }

  return '';
}

function renderDiffStats(stats) {
  const additions = Number(stats?.additions || 0);
  const removals = Number(stats?.removals || 0);
  const parts = [];
  if (additions > 0) {
    parts.push(`<span class="tool-diff-stat is-add">+${escapeHtml(String(additions))}</span>`);
  }
  if (removals > 0) {
    parts.push(`<span class="tool-diff-stat is-remove">-${escapeHtml(String(removals))}</span>`);
  }
  return parts.join('');
}

function renderDiffLine(line) {
  const kind = line.kind || 'context';
  const prefix = line.prefix === ' '
    ? '&nbsp;'
    : escapeHtml(line.prefix || '');
  return `
    <div class="tool-diff-line is-${escapeAttr(kind)}">
      <span class="tool-diff-prefix">${prefix}</span>
      <span class="tool-diff-text">${escapeHtml(line.text || '')}</span>
    </div>
  `;
}

function renderDiffHunk(hunk) {
  const header = hunk.header
    ? `<div class="tool-diff-hunk-header">${escapeHtml(hunk.header)}</div>`
    : '';
  const body = (hunk.lines || []).length
    ? hunk.lines.map(renderDiffLine).join('')
    : '<div class="tool-diff-empty">No recorded line changes.</div>';

  return `
    <div class="tool-diff-hunk">
      ${header}
      <div class="tool-diff-lines">${body}</div>
    </div>
  `;
}

function renderStructuredDiff(diff) {
  if (!diff) return '';

  if (diff.format === 'apply_patch') {
    return `
      <div class="tool-diff">
        ${(diff.files || []).map((file) => {
          const badgeLabel = file.kind === 'add'
            ? 'added'
            : file.kind === 'delete'
              ? 'deleted'
              : file.kind === 'move'
                ? 'moved'
                : 'updated';
          return `
            <section class="tool-diff-file kind-${escapeAttr(file.kind || 'update')}">
              <div class="tool-diff-file-header">
                <span class="tool-diff-file-path">${escapeHtml(file.displayPath || file.newPath || file.oldPath || 'file')}</span>
                <span class="tool-diff-file-badge">${escapeHtml(badgeLabel)}</span>
                <span class="tool-diff-file-stats">${renderDiffStats(file.stats)}</span>
              </div>
              ${(file.hunks || []).length
                ? file.hunks.map(renderDiffHunk).join('')
                : '<div class="tool-diff-empty">No recorded line changes.</div>'}
            </section>
          `;
        }).join('')}
      </div>
    `;
  }

  if (diff.format === 'generic') {
    return `
      <div class="tool-diff tool-diff-generic">
        <div class="tool-diff-file-header">
          <span class="tool-diff-file-path">Diff Output</span>
          <span class="tool-diff-file-stats">${renderDiffStats(diff.stats)}</span>
        </div>
        <div class="tool-diff-lines">
          ${(diff.lines || []).map(renderDiffLine).join('')}
        </div>
      </div>
    `;
  }

  return '';
}

function renderToolBlock(block) {
  const name = escapeHtml(block.name || 'Tool');
  const summaryText = escapeHtml(buildToolSummary(block));
  const detailHtml = renderToolDetailSections(block, { result: false });

  return `
    <div class="tool-block" onclick="this.classList.toggle('expanded')">
      <div class="tool-header">
        <span class="tool-badge">${name}</span>
        <span class="tool-summary">${summaryText}</span>
        ${renderToolMetaBadges(block)}
        <span class="tool-toggle">&#9654;</span>
      </div>
      <div class="tool-detail">${detailHtml}</div>
    </div>
  `;
}

function renderThinkingBlock(block, redacted = false) {
  const content = typeof block.text === 'string' ? block.text : '';
  const summarySource = content.trim()
    ? content.trim().split('\n')[0]
    : (redacted ? 'Reasoning content redacted by source session' : 'Thinking');
  const summaryText = escapeHtml(truncate(summarySource, 80));
  const detailText = escapeHtml(content || (redacted
    ? 'Reasoning content was redacted by the source session.'
    : 'No thinking content recorded.'));
  const badge = redacted ? 'Thinking (redacted)' : 'Thinking';
  const classes = redacted ? 'tool-block thinking-block redacted-thinking-block' : 'tool-block thinking-block';

  return `
    <div class="${classes}" onclick="this.classList.toggle('expanded')">
      <div class="tool-header">
        <span class="tool-badge">${escapeHtml(badge)}</span>
        <span class="tool-summary">${summaryText}</span>
        <span class="tool-toggle">&#9654;</span>
      </div>
      <pre class="tool-detail">${detailText}</pre>
    </div>
  `;
}

function renderToolResultBlock(block) {
  const summaryText = escapeHtml(buildToolSummary(block, block.isError ? 'Tool error' : 'Tool result'));
  const detailHtml = renderToolDetailSections(block, { result: true });

  return `
    <div class="tool-block${block.isError ? ' tool-block-error' : ''}" onclick="this.classList.toggle('expanded')">
      <div class="tool-header">
        <span class="tool-badge">Result</span>
        <span class="tool-summary">${summaryText}</span>
        ${renderToolMetaBadges(block)}
        <span class="tool-toggle">&#9654;</span>
      </div>
      <div class="tool-detail">${detailHtml}</div>
    </div>
  `;
}

function buildToolSummary(block, fallback = 'Tool') {
  if (typeof block.summary === 'string' && block.summary.trim()) {
    return truncate(block.summary.trim(), 100);
  }
  const parsedInputDiff = typeof block.input === 'string' ? parseRenderableDiff(block.input) : null;
  if (parsedInputDiff) {
    return truncate(buildDiffSummary(parsedInputDiff), 100);
  }
  if (typeof block.input === 'string' && block.input.trim()) {
    return truncate(block.input.trim().split('\n')[0], 100);
  }
  if (block.input && typeof block.input === 'object') {
    const summary = block.input.command || block.input.pattern || block.input.file_path || block.input.path || block.input.query || block.input.content || '';
    if (summary) return truncate(String(summary).split('\n')[0], 100);
  }
  const parsedContentDiff = typeof block.content === 'string' ? parseRenderableDiff(block.content) : null;
  if (parsedContentDiff) {
    return truncate(buildDiffSummary(parsedContentDiff), 100);
  }
  if (typeof block.content === 'string' && block.content.trim()) {
    return truncate(block.content.trim().split('\n')[0], 100);
  }
  if (typeof block.command === 'string' && block.command.trim()) {
    return truncate(block.command.trim().split('\n')[0], 100);
  }
  return fallback;
}

function renderToolMetaBadges(block) {
  const badges = [];
  if (Number.isInteger(block.exitCode)) {
    badges.push(`<span class="tool-mini-badge">exit ${escapeHtml(String(block.exitCode))}</span>`);
  }
  if (Array.isArray(block.changes) && block.changes.length) {
    badges.push(`<span class="tool-mini-badge">${escapeHtml(String(block.changes.length))} files</span>`);
  }
  const parsedDiff = typeof block.input === 'string'
    ? parseRenderableDiff(block.input)
    : (typeof block.content === 'string' ? parseRenderableDiff(block.content) : null);
  if (parsedDiff?.format === 'apply_patch' && (!Array.isArray(block.changes) || !block.changes.length)) {
    badges.push(`<span class="tool-mini-badge">${escapeHtml(String(parsedDiff.files.length))} files</span>`);
  }
  if (parsedDiff?.stats?.additions) {
    badges.push(`<span class="tool-mini-badge diff-add">+${escapeHtml(String(parsedDiff.stats.additions))}</span>`);
  }
  if (parsedDiff?.stats?.removals) {
    badges.push(`<span class="tool-mini-badge diff-remove">-${escapeHtml(String(parsedDiff.stats.removals))}</span>`);
  }
  if (block.isError) {
    badges.push('<span class="tool-mini-badge is-error">error</span>');
  }
  return badges.join('');
}

function renderToolDetailSections(block, options = {}) {
  const result = !!options.result;
  const includeInput = !!options.includeInput;
  const outputLabel = options.outputLabel || (block.isError ? 'Error' : 'Output');
  const sections = [];

  if (block.command) {
    sections.push(renderToolSection('Command', renderToolValue(block.command, 'bash')));
  }

  if ((!result || includeInput) && block.input != null) {
    sections.push(renderToolSection('Input', renderToolValue(block.input)));
  }

  if (Array.isArray(block.changes) && block.changes.length) {
    sections.push(renderToolSection('Changed Files', `
      <ul class="tool-change-list">
        ${block.changes.map((change) => `
          <li>
            <span class="tool-change-path">${escapeHtml(change.path || '(unknown)')}</span>
            ${change.kind ? `<span class="tool-change-kind">${escapeHtml(change.kind)}</span>` : ''}
          </li>
        `).join('')}
      </ul>
    `));
  }

  if (result && block.structured) {
    sections.push(renderToolSection('Metadata', renderToolValue(block.structured)));
  }

  if (result && block.content != null && !(typeof block.content === 'string' && !block.content.trim())) {
    sections.push(renderToolSection(outputLabel, renderToolValue(block.content)));
  }

  if (!result && sections.length === 0 && block.content) {
    sections.push(renderToolSection('Content', renderToolValue(block.content)));
  }

  if (!sections.length) {
    sections.push(renderToolSection('Details', '<div class="tool-empty">No additional details recorded.</div>'));
  }

  return sections.join('');
}

function renderToolSection(label, bodyHtml) {
  return `
    <div class="tool-section">
      <div class="tool-section-label">${escapeHtml(label)}</div>
      <div class="tool-section-body">${bodyHtml}</div>
    </div>
  `;
}

function renderToolValue(value, lang = '') {
  if (value == null) {
    return '<div class="tool-empty">None</div>';
  }

  if (typeof value === 'string') {
    const parsedDiff = parseRenderableDiff(value);
    if (parsedDiff) {
      return renderStructuredDiff(parsedDiff);
    }
    const className = looksLikeDiff(value) ? 'tool-code diff-like' : 'tool-code';
    const langClass = lang ? ` lang-${escapeAttr(lang)}` : '';
    return `<pre class="${className}${langClass}">${escapeHtml(value)}</pre>`;
  }

  if (Array.isArray(value) || typeof value === 'object') {
    return `<pre class="tool-code">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  }

  return `<pre class="tool-code">${escapeHtml(String(value))}</pre>`;
}

function looksLikeDiff(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.split('\n').slice(0, 12);
  return lines.some((line) => /^[+-][^+-]/.test(line)) || lines.some((line) => /^@@/.test(line));
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

function toggleSubagentGroup(groupEl) {
  if (!groupEl) return;
  groupEl.classList.toggle('expanded');
}

window.toggleSubagentGroup = toggleSubagentGroup;

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
