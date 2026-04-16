// session-list.js — Session list component

let _onSessionSelectCb = null;
let _onSessionDeleteCb = null;
let _onSessionPinCb = null;

function renderSessionList(sessions, selectedId, activeSessionIds = new Set(), pinnedSessionIds = new Set(), unreadSessionIds = new Set(), options = {}) {
  const container = document.getElementById('session-list');
  if (!sessions || sessions.length === 0) {
    if (options.hiddenArchivedCount > 0) {
      container.innerHTML = `<div class="empty-state">No active sessions shown. ${options.hiddenArchivedCount} archived session${options.hiddenArchivedCount === 1 ? '' : 's'} hidden.</div>`;
    } else {
      container.innerHTML = '<div class="empty-state">No sessions found</div>';
    }
    return;
  }

  container.innerHTML = sessions.map(s => {
    const isActive = s.sessionId === selectedId;
    const isBusy = activeSessionIds.has(s.sessionId);
    const isUnread = unreadSessionIds.has(s.sessionId);
    const isArchived = !!s.archived;
    const prompt = escapeHtml(truncate(s.firstPrompt || '(no prompt)', 60));
    const date = formatRelativeDate(s.modified || s.created);
    const summary = s.summary ? escapeHtml(truncate(s.summary, 80)) : '';
    const branch = s.gitBranch ? escapeHtml(s.gitBranch) : '';
    const sourceLabel = escapeHtml(s.sourceShortLabel || s.sourceLabel || s.source || '?');
    const sourceClass = escapeHtml(s.source || 'unknown');
    const draftBadge = s.isDraft ? '<span class="session-draft-badge">DRAFT</span>' : '';
    const liveBadge = isBusy ? '<span class="session-live-badge">LIVE</span>' : '';
    const pinLabel = pinnedSessionIds.has(s.sessionId) ? 'Unpin' : 'Pin';
    const pinClass = pinnedSessionIds.has(s.sessionId) ? ' is-pinned' : '';
    const titleTooltip = typeof window.__dashboardBuildSessionTitleTooltip === 'function'
      ? window.__dashboardBuildSessionTitleTooltip(s)
      : (s.firstPrompt || '');
    const cacheInfo = typeof window.__dashboardSessionCacheInfo === 'function'
      ? window.__dashboardSessionCacheInfo(s)
      : null;
    const cacheTooltip = typeof window.__dashboardBuildSessionCacheTooltip === 'function'
      ? window.__dashboardBuildSessionCacheTooltip(s)
      : '';
    const cacheBadge = cacheInfo
      ? `<span class="session-cache-badge" title="${escapeHtml(cacheTooltip)}">CACHE ${cacheInfo.percent}%</span>`
      : '';
    const archivedBadge = isArchived
      ? `<span class="session-archived-badge" title="Archived in VS Code Codex">ARCHIVED</span>`
      : '';
    const forkTooltip = typeof window.__dashboardBuildSessionForkTooltip === 'function'
      ? window.__dashboardBuildSessionForkTooltip(s)
      : '';
    const forkBadge = s.forkedFromId
      ? `<span class="session-fork-badge" title="${escapeHtml(forkTooltip || `Forked from ${s.forkedFromId}`)}">FORK ${escapeHtml(String(s.forkedFromId).slice(0, 8))}</span>`
      : '';
    const fileSizeLabel = typeof window.__dashboardSessionFileSizeLabel === 'function'
      ? window.__dashboardSessionFileSizeLabel(s)
      : '';
    const fileSizeTooltip = typeof window.__dashboardSessionFileSizeTooltip === 'function'
      ? window.__dashboardSessionFileSizeTooltip(s)
      : '';
    const fileSizeBadge = fileSizeLabel
      ? `<span class="session-file-badge" title="${escapeHtml(fileSizeTooltip || fileSizeLabel)}">${escapeHtml(fileSizeLabel)}</span>`
      : '';
    const contextInfo = typeof window.__dashboardSessionContextInfo === 'function'
      ? window.__dashboardSessionContextInfo(s)
      : null;
    const contextTooltip = typeof window.__dashboardBuildSessionContextTooltip === 'function'
      ? window.__dashboardBuildSessionContextTooltip(s)
      : '';
    const contextBar = contextInfo
      ? `<div class="session-context-bar" title="${escapeHtml(contextTooltip)}"><span class="session-context-bar-fill" style="width:${Math.max(2, contextInfo.percent)}%"></span></div>`
      : '';
    const claudeConfigBadge = s.source === 'claude' && s.claudeProfileLabel
      ? `<span class="session-config-badge" title="${escapeHtml(s.claudeConfigSource || '')}${s.claudeProfileHint ? `: ${escapeHtml(s.claudeProfileHint)}` : ''}">${escapeHtml(s.claudeProfileLabel)}</span>`
      : '';

    return `
      <div class="session-item${isActive ? ' active' : ''}${isBusy ? ' is-busy' : ''}${isUnread ? ' is-unread' : ''}${isArchived ? ' is-archived' : ''}" data-id="${escapeHtml(s.sessionId)}">
        <button class="session-pin-btn${pinClass}" data-pin-id="${escapeHtml(s.sessionId)}" title="${pinLabel} session">${pinLabel}</button>
        <button class="session-delete-btn" data-delete-id="${escapeHtml(s.sessionId)}" title="Delete session">Delete</button>
        <div class="session-prompt" title="${escapeHtml(titleTooltip)}">${prompt}</div>
        <div class="session-meta">
          <span class="session-source-badge source-${sourceClass}" title="${escapeHtml(s.sourceLabel || s.source || '')}">${sourceLabel}</span>
          ${forkBadge}
          ${fileSizeBadge}
          ${claudeConfigBadge}
          ${cacheBadge}
          ${archivedBadge}
          ${liveBadge}
          ${isUnread ? '<span class="session-unread-badge">NEW</span>' : ''}
          ${draftBadge}
          <span class="session-date">${date}</span>
          <span class="session-msg-count">${s.messageCount} msgs</span>
          ${branch ? `<span class="session-branch" title="${branch}">${branch}</span>` : ''}
        </div>
        ${summary ? `<div class="session-summary" title="${escapeHtml(s.summary)}">${summary}</div>` : ''}
        ${contextBar}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (_onSessionSelectCb) _onSessionSelectCb(id);
    });
  });

  container.querySelectorAll('.session-delete-btn').forEach(el => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = el.dataset.deleteId;
      if (_onSessionDeleteCb) _onSessionDeleteCb(id);
    });
  });

  container.querySelectorAll('.session-pin-btn').forEach(el => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = el.dataset.pinId;
      if (_onSessionPinCb) _onSessionPinCb(id);
    });
  });
}

function onSessionSelect(callback) {
  _onSessionSelectCb = callback;
}

function onSessionDelete(callback) {
  _onSessionDeleteCb = callback;
}

function onSessionPin(callback) {
  _onSessionPinCb = callback;
}

function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}

function formatRelativeDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
  return date.toLocaleDateString();
}
