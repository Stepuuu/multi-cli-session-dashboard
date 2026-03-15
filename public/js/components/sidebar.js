// sidebar.js — Project list component

let _onProjectSelectCb = null;
const PROJECT_SOURCE_LABELS = {
  claude: 'CC',
  codex: 'CX',
  copilot: 'CP',
};

function renderProjectList(projects, selectedDir) {
  const container = document.getElementById('project-list');
  if (!projects || projects.length === 0) {
    container.innerHTML = '<div class="empty-state">No projects found</div>';
    return;
  }

  container.innerHTML = projects.map(p => {
    const isActive = p.dirName === selectedDir;
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
      <div class="project-item${isActive ? ' active' : ''}" data-dir="${escapeHtml(p.dirName)}">
        <div class="project-main">
          <span class="project-name" title="${escapeHtml(p.path)}">${name}</span>
          ${sourceBadges ? `<div class="project-source-row">${sourceBadges}</div>` : ''}
        </div>
        <span class="project-count">${p.sessionCount}</span>
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
