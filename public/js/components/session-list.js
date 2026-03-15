// session-list.js — Session list component

let _onSessionSelectCb = null;

function renderSessionList(sessions, selectedId) {
  const container = document.getElementById('session-list');
  if (!sessions || sessions.length === 0) {
    container.innerHTML = '<div class="empty-state">No sessions found</div>';
    return;
  }

  container.innerHTML = sessions.map(s => {
    const isActive = s.sessionId === selectedId;
    const prompt = escapeHtml(truncate(s.firstPrompt || '(no prompt)', 60));
    const date = formatRelativeDate(s.modified || s.created);
    const summary = s.summary ? escapeHtml(truncate(s.summary, 80)) : '';
    const branch = s.gitBranch ? escapeHtml(s.gitBranch) : '';
    const sourceLabel = escapeHtml(s.sourceShortLabel || s.sourceLabel || s.source || '?');
    const sourceClass = escapeHtml(s.source || 'unknown');
    const draftBadge = s.isDraft ? '<span class="session-draft-badge">DRAFT</span>' : '';

    return `
      <div class="session-item${isActive ? ' active' : ''}" data-id="${escapeHtml(s.sessionId)}">
        <div class="session-prompt" title="${escapeHtml(s.firstPrompt || '')}">${prompt}</div>
        <div class="session-meta">
          <span class="session-source-badge source-${sourceClass}" title="${escapeHtml(s.sourceLabel || s.source || '')}">${sourceLabel}</span>
          ${draftBadge}
          <span class="session-date">${date}</span>
          <span class="session-msg-count">${s.messageCount} msgs</span>
          ${branch ? `<span class="session-branch" title="${branch}">${branch}</span>` : ''}
        </div>
        ${summary ? `<div class="session-summary" title="${escapeHtml(s.summary)}">${summary}</div>` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (_onSessionSelectCb) _onSessionSelectCb(id);
    });
  });
}

function onSessionSelect(callback) {
  _onSessionSelectCb = callback;
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
