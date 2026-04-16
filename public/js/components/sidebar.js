// sidebar.js — Project list component

let _onProjectSelectCb = null;
const PROJECT_SOURCE_LABELS = {
  claude: 'CC',
  codex: 'CX',
  copilot: 'CP',
};

function renderProjectList(projects, selectedDir, activeProjectIds = new Set(), unreadProjects = new Map()) {
  const container = document.getElementById('project-list');
  if (!projects || projects.length === 0) {
    container.innerHTML = '<div class="empty-state">No projects found</div>';
    return;
  }

  container.innerHTML = projects.map(p => {
    const isActive = p.dirName === selectedDir;
    const hasLive = activeProjectIds.has(p.dirName);
    const unreadCount = unreadProjects.get(p.dirName) || 0;
    const archivedCount = p.archivedSessionCount || 0;
    const name = escapeHtml(p.name);
    const sourceBadges = (p.sources || []).map((source) => {
      const short = PROJECT_SOURCE_LABELS[source] || source.slice(0, 2).toUpperCase();
      const count = (p.sourceCounts && p.sourceCounts[source]) || '';
      return `
        <span
          class="project-source-badge source-${escapeHtml(source)}"
          title="${escapeHtml(source)}${count ? `: ${count} session${count === 1 ? '' : 's'}` : ''}"
        >${escapeHtml(short)}</span>
      `;
    }).join('');

    return `
      <div class="project-item${isActive ? ' active' : ''}${hasLive ? ' has-live' : ''}${unreadCount ? ' has-unread' : ''}" data-dir="${escapeHtml(p.dirName)}">
        <div class="project-main">
          <span class="project-name" title="${escapeHtml(p.path)}">${name}</span>
          <div class="project-source-row">
            ${hasLive ? '<span class="project-live-badge">LIVE</span>' : ''}
            ${unreadCount ? `<span class="project-unread-badge">${unreadCount > 9 ? '9+' : unreadCount}</span>` : ''}
            ${archivedCount ? `<span class="project-archived-badge" title="${archivedCount} archived session${archivedCount === 1 ? '' : 's'} hidden from the main list by default">AR ${archivedCount}</span>` : ''}
            ${sourceBadges}
          </div>
        </div>
        <span class="project-count" title="${archivedCount ? `${p.sessionCount} active · ${archivedCount} archived` : `${p.sessionCount} active`}">${p.sessionCount}</span>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.project-item').forEach(el => {
    el.addEventListener('click', () => {
      const dir = el.dataset.dir;
      if (_onProjectSelectCb) _onProjectSelectCb(dir);
    });
  });
}

function onProjectSelect(callback) {
  _onProjectSelectCb = callback;
}
