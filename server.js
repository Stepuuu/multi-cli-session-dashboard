import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getInteractionCapabilities, handleInteractionRequest } from './interaction.js';
import { loadRuntimeConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_META = {
  claude: { label: 'Claude', shortLabel: 'CC' },
  codex: { label: 'Codex', shortLabel: 'CX' },
  copilot: { label: 'Copilot', shortLabel: 'CP' },
};

const config = loadRuntimeConfig();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const TRASH_ROOT = '/tmp/session-dashboard-trash';
const SESSION_TITLE_OVERRIDES_FILE = path.join(__dirname, 'data', 'session-title-overrides.json');
const CLAUDE_PROVENANCE_FILE = path.join(__dirname, 'data', 'claude-session-provenance.json');
const SESSION_METADATA_CACHE_FILE = path.join(__dirname, 'data', 'session-metadata-cache.json');
const SESSION_SNAPSHOT_TTL_MS = 1500;
const MESSAGE_CACHE_LIMIT = 32;
let sessionTitleOverridesLoaded = false;
let sessionTitleOverrides = {};
let claudeProvenanceLoaded = false;
let claudeSessionProvenance = {};
let claudeProfilesLoaded = false;
let claudeProfilesCache = null;
let sessionMetadataCacheLoaded = false;
let sessionMetadataCacheDirty = false;
const sessionMetadataCache = new Map();
let sessionsSnapshotCache = null;
const messageParseCache = new Map();

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
  });
  res.end(body);
}

function sendError(res, message, status = 500) {
  sendJSON(res, { error: message }, status);
}

async function ensureSessionTitleOverridesLoaded() {
  if (sessionTitleOverridesLoaded) return;
  sessionTitleOverridesLoaded = true;

  try {
    const raw = await fsp.readFile(SESSION_TITLE_OVERRIDES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    sessionTitleOverrides = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    sessionTitleOverrides = {};
  }
}

async function persistSessionTitleOverrides() {
  await fsp.mkdir(path.dirname(SESSION_TITLE_OVERRIDES_FILE), { recursive: true });
  await fsp.writeFile(
    SESSION_TITLE_OVERRIDES_FILE,
    JSON.stringify(sessionTitleOverrides, null, 2) + '\n',
    'utf-8',
  );
}

async function ensureSessionMetadataCacheLoaded() {
  if (sessionMetadataCacheLoaded) return;
  sessionMetadataCacheLoaded = true;

  try {
    const raw = await fsp.readFile(SESSION_METADATA_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const entries = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    for (const [key, value] of Object.entries(entries)) {
      if (!value || typeof value !== 'object') continue;
      sessionMetadataCache.set(key, value);
    }
  } catch {
    sessionMetadataCache.clear();
  }
}

async function persistSessionMetadataCache() {
  if (!sessionMetadataCacheDirty) return;
  sessionMetadataCacheDirty = false;

  const payload = {
    savedAt: new Date().toISOString(),
    entries: Object.fromEntries(sessionMetadataCache.entries()),
  };

  await fsp.mkdir(path.dirname(SESSION_METADATA_CACHE_FILE), { recursive: true });
  await fsp.writeFile(
    SESSION_METADATA_CACHE_FILE,
    JSON.stringify(payload, null, 2) + '\n',
    'utf-8',
  );
}

function invalidateSessionsSnapshotCache() {
  sessionsSnapshotCache = null;
}

function buildSessionMetadataCacheKey(source, filePath) {
  return `${source}:${filePath}`;
}

function buildFileFingerprint(stat, extra = '') {
  const extraPart = extra ? `:${extra}` : '';
  return `${Math.floor(stat.mtimeMs)}:${stat.size}${extraPart}`;
}

function getCachedSessionMetadata(cacheKey, fingerprint) {
  const cached = sessionMetadataCache.get(cacheKey);
  if (!cached || cached.fingerprint !== fingerprint) return null;
  return cached.data || null;
}

function setCachedSessionMetadata(cacheKey, fingerprint, data) {
  sessionMetadataCache.set(cacheKey, {
    fingerprint,
    data,
  });
  sessionMetadataCacheDirty = true;
}

function getMessageCache(cacheKey, fingerprint) {
  const cached = messageParseCache.get(cacheKey);
  if (!cached || cached.fingerprint !== fingerprint) return null;
  messageParseCache.delete(cacheKey);
  messageParseCache.set(cacheKey, cached);
  return cached.messages;
}

function setMessageCache(cacheKey, fingerprint, messages) {
  if (messageParseCache.has(cacheKey)) {
    messageParseCache.delete(cacheKey);
  }
  messageParseCache.set(cacheKey, { fingerprint, messages });

  while (messageParseCache.size > MESSAGE_CACHE_LIMIT) {
    const firstKey = messageParseCache.keys().next().value;
    if (!firstKey) break;
    messageParseCache.delete(firstKey);
  }
}

function invalidateMessageCache(cacheKey) {
  if (!cacheKey) return;
  messageParseCache.delete(cacheKey);
}

function buildProjectDigest(projects) {
  return projects.map((project) => ({
    dirName: project.dirName,
    sessionCount: project.sessionCount,
    latestModified: project.latestModified || 0,
    sourceCounts: project.sourceCounts || {},
  }));
}

function buildSessionDigest(sessions) {
  return sessions.map((session) => ({
    sessionId: session.sessionId,
    source: session.source,
    rawSessionId: session.rawSessionId || '',
    modified: session.modified || '',
    messageCount: session.messageCount || 0,
    model: session.model || '',
    title: session.customTitle || session.firstPrompt || '',
  }));
}

async function ensureClaudeProvenanceLoaded() {
  if (claudeProvenanceLoaded) return;
  claudeProvenanceLoaded = true;
  try {
    const raw = await fsp.readFile(CLAUDE_PROVENANCE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    claudeSessionProvenance = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    claudeSessionProvenance = {};
  }
}

function parseClaudeModelsJson(raw) {
  const parsed = safeJsonParse(raw);
  const models = parsed?.models && typeof parsed.models === 'object' ? parsed.models : {};
  const byName = {};
  const byModel = new Map();

  for (const [name, entry] of Object.entries(models)) {
    const env = entry?.env && typeof entry.env === 'object' ? entry.env : {};
    const anthropicModel = env.ANTHROPIC_MODEL || '';
    const baseUrl = env.ANTHROPIC_BASE_URL || '';
    const label = name === 'aliyun' ? 'ALIYUN'
      : name === 'cliproxy' ? 'CLIPROXY'
      : name === 'gpt' ? 'GPT'
      : name === 'deepseek' ? 'DEEPSEEK'
      : name === 'openrouter' ? 'OPENROUTER'
      : name === 'sii' ? 'SII'
      : name === 'fujie' ? 'FUJIE'
      : name.toUpperCase();
    byName[name] = {
      name,
      label,
      anthropicModel,
      baseUrl,
      description: entry?.description || '',
    };
    if (anthropicModel) {
      if (!byModel.has(anthropicModel)) byModel.set(anthropicModel, []);
      byModel.get(anthropicModel).push(byName[name]);
    }
  }

  return { byName, byModel };
}

function preferredClaudeProfileForModel(model) {
  const value = (model || '').toLowerCase();
  if (!value) return '';
  if (value.includes('kimi')) return 'aliyun';
  if (value.includes('gpt-5.4')) return 'gpt';
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('claude-sonnet') || value.includes('claude-opus') || value.includes('claude-haiku')) {
    return 'cliproxy';
  }
  return '';
}

async function ensureClaudeProfilesLoaded() {
  if (claudeProfilesLoaded) return;
  claudeProfilesLoaded = true;
  try {
    const realProjectsDir = await fsp.realpath(config.claudeProjectsDir);
    const modelsFile = path.join(path.dirname(path.dirname(realProjectsDir)), '.models.json');
    const raw = await fsp.readFile(modelsFile, 'utf-8');
    claudeProfilesCache = parseClaudeModelsJson(raw);
  } catch {
    claudeProfilesCache = { byName: {}, byModel: new Map() };
  }
}

async function serveStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const publicRoot = path.join(__dirname, 'public');
  const filePath = path.join(publicRoot, requestPath);

  if (!filePath.startsWith(publicRoot)) {
    sendError(res, 'Forbidden', 403);
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendError(res, 'Not Found', 404);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendError(res, 'Not Found', 404);
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function encodeToken(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeToken(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

function buildSessionTitleOverrideKey({ source, projectPath, rawSessionId }) {
  if (!source || !projectPath || !rawSessionId) return '';
  return JSON.stringify({ source, projectPath, rawSessionId });
}

function applySessionTitleOverride(session) {
  const defaultFirstPrompt = session.firstPrompt || '(no prompt)';
  const key = buildSessionTitleOverrideKey(session);
  const customTitle = key ? sessionTitleOverrides[key] || '' : '';

  return {
    ...session,
    defaultFirstPrompt,
    customTitle,
    firstPrompt: customTitle || defaultFirstPrompt,
  };
}

function decorateClaudeSessionConfig(session) {
  const key = buildSessionTitleOverrideKey(session);
  const saved = key ? claudeSessionProvenance[key] || null : null;

  if (saved) {
    return {
      ...session,
      claudeProfile: saved.profile || '',
      claudeProfileLabel: saved.profileLabel || (saved.profile ? saved.profile.toUpperCase() : ''),
      claudeProfileHint: saved.profile || '',
      claudeProfileExact: true,
      claudeBaseUrl: saved.baseUrl || '',
      claudeModel: saved.anthropicModel || session.model || '',
      claudeConfigSource: saved.source || 'recorded',
    };
  }

  const model = session.model || '';
  const candidates = model ? (claudeProfilesCache?.byModel.get(model) || []) : [];
  if (candidates.length === 1) {
    const candidate = candidates[0];
    return {
      ...session,
      claudeProfile: candidate.name,
      claudeProfileLabel: candidate.label,
      claudeProfileHint: candidate.name,
      claudeProfileExact: false,
      claudeBaseUrl: candidate.baseUrl,
      claudeModel: candidate.anthropicModel || model,
      claudeConfigSource: 'inferred-model',
    };
  }

  if (candidates.length > 1) {
    const preferred = preferredClaudeProfileForModel(model);
    const preferredCandidate = preferred ? candidates.find((candidate) => candidate.name === preferred) : null;
    if (preferredCandidate) {
      return {
        ...session,
        claudeProfile: preferredCandidate.name,
        claudeProfileLabel: preferredCandidate.label,
        claudeProfileHint: preferredCandidate.name,
        claudeProfileExact: false,
        claudeBaseUrl: preferredCandidate.baseUrl,
        claudeModel: preferredCandidate.anthropicModel || model,
        claudeConfigSource: 'default-model-family',
      };
    }

    return {
      ...session,
      claudeProfile: '',
      claudeProfileLabel: 'MULTI',
      claudeProfileHint: candidates.map((c) => c.label).join('/'),
      claudeProfileExact: false,
      claudeBaseUrl: '',
      claudeModel: model,
      claudeConfigSource: 'ambiguous-model',
    };
  }

  const preferred = preferredClaudeProfileForModel(model);
  const preferredByName = preferred ? claudeProfilesCache?.byName?.[preferred] : null;
  if (preferredByName) {
    return {
      ...session,
      claudeProfile: preferredByName.name,
      claudeProfileLabel: preferredByName.label,
      claudeProfileHint: preferredByName.name,
      claudeProfileExact: false,
      claudeBaseUrl: preferredByName.baseUrl,
      claudeModel: preferredByName.anthropicModel || model,
      claudeConfigSource: 'default-model-family',
    };
  }

  return {
    ...session,
    claudeProfile: '',
    claudeProfileLabel: model ? 'MODEL' : '',
    claudeProfileHint: model || '',
    claudeProfileExact: false,
    claudeBaseUrl: '',
    claudeModel: model,
    claudeConfigSource: model ? 'model-only' : 'unknown',
  };
}

function truncateText(text, limit = 500) {
  const str = typeof text === 'string' ? text : JSON.stringify(text || '');
  if (str.length <= limit) return str;
  return str.slice(0, limit) + '...';
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
}

function extractClaudePlainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === 'object' && block.type === 'text')
      .map((block) => block.text || '')
      .join('\n');
  }
  return normalizeText(content);
}

function extractTaggedBlock(text, tag) {
  if (typeof text !== 'string') return '';
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function parseClaudeWrapper(text) {
  if (typeof text !== 'string' || !text.includes('<')) return null;

  const commandName = extractTaggedBlock(text, 'command-name');
  const commandMessage = extractTaggedBlock(text, 'command-message');
  const commandArgs = extractTaggedBlock(text, 'command-args');
  const localCaveat = extractTaggedBlock(text, 'local-command-caveat');
  const localStdout = extractTaggedBlock(text, 'local-command-stdout');
  const localStderr = extractTaggedBlock(text, 'local-command-stderr');
  const localStatus = extractTaggedBlock(text, 'local-command-status');

  if (commandName || commandMessage || commandArgs) {
    const parts = [];
    if (commandName) {
      parts.push(commandName);
    } else if (commandMessage) {
      parts.push(commandMessage);
    }
    if (commandArgs) parts.push(commandArgs);
    return {
      kind: 'command',
      text: parts.filter(Boolean).join(' ').trim() || commandMessage || commandName || 'Command',
      commandName,
      commandMessage,
      commandArgs,
    };
  }

  if (localStdout) {
    return { kind: 'local_stdout', text: localStdout };
  }
  if (localStderr) {
    return { kind: 'local_stderr', text: localStderr };
  }
  if (localStatus) {
    return { kind: 'local_status', text: localStatus };
  }
  if (localCaveat) {
    return { kind: 'local_caveat', text: localCaveat };
  }

  return null;
}

function cleanClaudePromptText(text) {
  if (typeof text !== 'string') return '';
  if (parseClaudeSkillContext(text)) return '';
  const wrapper = parseClaudeWrapper(text);
  if (!wrapper) return truncateText(text.trim(), 200);

  if (wrapper.kind === 'command') {
    return truncateText(wrapper.text, 200);
  }

  if (wrapper.kind === 'local_caveat') {
    return '';
  }

  if (wrapper.kind === 'local_stdout' || wrapper.kind === 'local_stderr' || wrapper.kind === 'local_status') {
    return '';
  }

  return truncateText(wrapper.text || '', 200);
}

function parseClaudeSkillContext(content) {
  const text = extractClaudePlainText(content).trim();
  if (!text.startsWith('Base directory for this skill:')) return null;

  const skillPathMatch = text.match(/Base directory for this skill:\s*(.+)/);
  const skillPath = skillPathMatch ? skillPathMatch[1].split(/\r?\n/)[0].trim() : '';
  const pathName = skillPath ? path.basename(skillPath) : '';

  let skillName = pathName;
  const headingMatch = text.match(/^#\s+(.+)$/m);
  if (!skillName && headingMatch) {
    skillName = headingMatch[1].trim();
  }

  return {
    kind: 'skill_context',
    skillName: skillName || 'skill',
    text: `Loaded skill context: ${skillName || 'skill'}`,
  };
}

function displayNameFromPath(projectPath) {
  if (!projectPath) return '(unknown)';
  const trimmed = projectPath.replace(/\/+$/, '');
  if (!trimmed) return projectPath;
  const base = path.basename(trimmed);
  return base || trimmed;
}

function normalizeProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return '(unknown)';
  }
  return projectPath.trim();
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function movePathToTrash(sourcePath, bucket) {
  await fsp.mkdir(path.join(TRASH_ROOT, bucket), { recursive: true });
  const targetPath = path.join(
    TRASH_ROOT,
    bucket,
    `${Date.now()}-${path.basename(sourcePath)}`
  );

  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fsp.cp(sourcePath, targetPath, { recursive: true });
      await fsp.rm(sourcePath, { recursive: true, force: true });
    } else {
      throw err;
    }
  }

  return targetPath;
}

async function walkFiles(rootDir, predicate, acc = []) {
  let entries = [];
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, predicate, acc);
    } else if (!predicate || predicate(fullPath, entry)) {
      acc.push(fullPath);
    }
  }

  return acc;
}

async function readSimpleYaml(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    const result = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function extractClaudeDisplayName(dirName, sessionsIndex) {
  if (sessionsIndex) {
    const projectPath =
      sessionsIndex.originalPath ||
      sessionsIndex.projectPath ||
      sessionsIndex.entries?.[0]?.projectPath;
    if (projectPath) {
      return displayNameFromPath(projectPath);
    }
  }

  const cleaned = dirName.replace(/^-/, '');
  const parts = cleaned.split('-');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] && parts[i].length > 1) {
      return parts[i];
    }
  }
  return dirName;
}

function extractClaudeProjectPath(dirName, sessionsIndex) {
  if (sessionsIndex) {
    const projectPath =
      sessionsIndex.originalPath ||
      sessionsIndex.projectPath ||
      sessionsIndex.entries?.[0]?.projectPath;
    if (projectPath) return projectPath;
  }
  return '/' + dirName.replace(/^-/, '').split('-').join('/');
}

async function readClaudeSessionsIndex(projectPath) {
  try {
    const raw = await fsp.readFile(path.join(projectPath, 'sessions-index.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function scanClaudeMetadata(filePath) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let firstPrompt = '';
    let messageCount = 0;
    let gitBranch = '';
    let model = '';

    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;

      if (obj.type !== 'user' && obj.type !== 'assistant' && obj.type !== 'system') {
        return;
      }

      if (obj.type === 'user') {
        const content = obj.message?.content;
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          messageCount++;
          return;
        }
        if (!firstPrompt && parseClaudeSkillContext(content)) {
          return;
        }
        if (!firstPrompt && content) {
          const cleaned = cleanClaudePromptText(extractClaudePlainText(content));
          if (cleaned) {
            firstPrompt = cleaned;
          }
        }
        if (!gitBranch && obj.gitBranch) {
          gitBranch = obj.gitBranch;
        }
      }

      if (obj.type === 'assistant' && obj.message?.model && !model) {
        model = obj.message.model;
      }

      messageCount++;
    });

    rl.on('close', () => resolve({ firstPrompt, messageCount, gitBranch, model }));
    rl.on('error', reject);
  });
}

async function collectClaudeSessions() {
  let entries = [];
  try {
    entries = await fsp.readdir(config.claudeProjectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirName = entry.name;
    const dirPath = path.join(config.claudeProjectsDir, dirName);
    const sessionsIndex = await readClaudeSessionsIndex(dirPath);
    const indexMap = new Map((sessionsIndex?.entries || []).map((item) => [item.sessionId, item]));

    let files = [];
    try {
      files = await fsp.readdir(dirPath);
    } catch {
      continue;
    }

    const jsonlFiles = files.filter((name) => name.endsWith('.jsonl') && name !== 'sessions-index.json');
    const projectPath = normalizeProjectPath(extractClaudeProjectPath(dirName, sessionsIndex));
    const projectName = extractClaudeDisplayName(dirName, sessionsIndex);

    for (const file of jsonlFiles) {
      const rawSessionId = file.replace(/\.jsonl$/, '');
      const filePath = path.join(dirPath, file);
      const indexEntry = indexMap.get(rawSessionId);

      let fileStat;
      try {
        fileStat = await fsp.stat(filePath);
      } catch {
        continue;
      }

      const indexFingerprint = indexEntry
        ? JSON.stringify([
            indexEntry.firstPrompt || '',
            indexEntry.summary || '',
            indexEntry.messageCount || 0,
            indexEntry.created || '',
            indexEntry.modified || '',
            indexEntry.gitBranch || '',
          ])
        : '';
      const cacheKey = buildSessionMetadataCacheKey('claude', filePath);
      const fingerprint = buildFileFingerprint(fileStat, indexFingerprint);
      const cached = getCachedSessionMetadata(cacheKey, fingerprint);
      if (cached) {
        sessions.push(cached);
        continue;
      }

      let firstPrompt = '';
      let summary = '';
      let messageCount = 0;
      let created = fileStat.birthtime.toISOString();
      let modified = fileStat.mtime.toISOString();
      let gitBranch = '';
      let model = '';

      if (indexEntry) {
        firstPrompt = cleanClaudePromptText(indexEntry.firstPrompt || '');
        summary = indexEntry.summary || '';
        messageCount = indexEntry.messageCount || 0;
        created = indexEntry.created || created;
        modified = indexEntry.modified || modified;
        gitBranch = indexEntry.gitBranch || '';
      } else {
        const scanned = await scanClaudeMetadata(filePath);
        firstPrompt = scanned.firstPrompt;
        messageCount = scanned.messageCount;
        gitBranch = scanned.gitBranch;
        model = scanned.model || '';
      }

      if (!firstPrompt) {
        const rescanned = await scanClaudeMetadata(filePath);
        firstPrompt = rescanned.firstPrompt || firstPrompt;
        if (!messageCount) messageCount = rescanned.messageCount;
        if (!gitBranch) gitBranch = rescanned.gitBranch;
        if (!model) model = rescanned.model || '';
      }

      const session = {
        source: 'claude',
        sourceLabel: SOURCE_META.claude.label,
        sourceShortLabel: SOURCE_META.claude.shortLabel,
        projectPath,
        projectName,
        rawSessionId,
        firstPrompt,
        summary,
        messageCount,
        created,
        modified,
        gitBranch,
        model,
        sessionId: encodeToken({
          source: 'claude',
          projectPath,
          projectDir: dirName,
          rawSessionId,
        }),
      };

      setCachedSessionMetadata(cacheKey, fingerprint, session);
      sessions.push(session);
    }
  }

  return sessions;
}

async function scanCodexMetadata(filePath) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    const fallbackSessionId = path.basename(filePath, '.jsonl');
    let rawSessionId = fallbackSessionId;
    let projectPath = '';
    let firstPrompt = '';
    let messageCount = 0;
    let created = '';
    let gitBranch = '';
    let model = '';

    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;

      if (obj.type === 'session_meta') {
        rawSessionId = obj.payload?.id || rawSessionId;
        projectPath = obj.payload?.cwd || projectPath;
        created = obj.payload?.timestamp || obj.timestamp || created;
        model = obj.payload?.model || model;
        return;
      }

      if (obj.type === 'turn_context') {
        gitBranch = obj.payload?.git?.branch || gitBranch;
        model = obj.payload?.model || model;
        return;
      }

      if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
        if (!firstPrompt && obj.payload?.message) {
          firstPrompt = truncateText(normalizeText(obj.payload.message), 200);
        }
        messageCount++;
        return;
      }

      if (obj.type === 'response_item') {
        const payload = obj.payload || {};
        if (payload.type === 'message' && payload.role === 'assistant') {
          messageCount++;
        }
      }
    });

    rl.on('close', () => {
      resolve({
        rawSessionId,
        projectPath: normalizeProjectPath(projectPath),
        firstPrompt,
        messageCount,
        created,
        gitBranch,
        model,
      });
    });
    rl.on('error', reject);
  });
}

async function collectCodexSessions() {
  const files = await walkFiles(
    config.codexSessionsDir,
    (filePath) => filePath.endsWith('.jsonl')
  );

  const sessions = [];

  for (const filePath of files) {
    let fileStat;
    try {
      fileStat = await fsp.stat(filePath);
    } catch {
      continue;
    }

    const cacheKey = buildSessionMetadataCacheKey('codex', filePath);
    const fingerprint = buildFileFingerprint(fileStat);
    const cached = getCachedSessionMetadata(cacheKey, fingerprint);
    if (cached) {
      sessions.push(cached);
      continue;
    }

    const metadata = await scanCodexMetadata(filePath);
    const relativePath = path.relative(config.codexSessionsDir, filePath);
    const projectPath = normalizeProjectPath(metadata.projectPath);

    const session = {
      source: 'codex',
      sourceLabel: SOURCE_META.codex.label,
      sourceShortLabel: SOURCE_META.codex.shortLabel,
      projectPath,
      projectName: displayNameFromPath(projectPath),
      rawSessionId: metadata.rawSessionId,
      firstPrompt: metadata.firstPrompt,
      summary: '',
      messageCount: metadata.messageCount,
      created: metadata.created || fileStat.birthtime.toISOString(),
      modified: fileStat.mtime.toISOString(),
      gitBranch: metadata.gitBranch || '',
      model: metadata.model || '',
      sessionId: encodeToken({
        source: 'codex',
        projectPath,
        relativePath,
        rawSessionId: metadata.rawSessionId,
      }),
    };

    setCachedSessionMetadata(cacheKey, fingerprint, session);
    sessions.push(session);
  }

  return sessions;
}

function extractCopilotModel(message) {
  if (typeof message !== 'string') return '';
  const match = message.match(/Model changed to:\s*(.+)$/);
  return match ? match[1].trim() : message.trim();
}

async function scanCopilotMetadata(eventsPath, workspaceInfo) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(eventsPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    const fallbackSessionId = path.basename(path.dirname(eventsPath));
    let rawSessionId = fallbackSessionId;
    let projectPath = workspaceInfo.cwd || '';
    let firstPrompt = '';
    let messageCount = 0;
    let created = workspaceInfo.created_at || '';
    let gitBranch = '';
    let model = '';

    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;

      if (obj.type === 'session.start') {
        rawSessionId = obj.data?.sessionId || rawSessionId;
        projectPath = obj.data?.context?.cwd || projectPath;
        gitBranch = obj.data?.context?.branch || gitBranch;
        created = obj.data?.startTime || created;
        return;
      }

      if (obj.type === 'session.model_change' || obj.type === 'session.info') {
        if (!model && obj.data?.message) {
          model = extractCopilotModel(obj.data.message);
        }
        return;
      }

      if (obj.type === 'user.message') {
        if (!firstPrompt && obj.data?.content) {
          firstPrompt = truncateText(normalizeText(obj.data.content), 200);
        }
        messageCount++;
        return;
      }

      if (obj.type === 'assistant.message') {
        messageCount++;
      }
    });

    rl.on('close', () => {
      resolve({
        rawSessionId,
        projectPath: normalizeProjectPath(projectPath),
        firstPrompt,
        messageCount,
        created,
        gitBranch,
        model,
      });
    });
    rl.on('error', reject);
  });
}

async function collectCopilotSessions() {
  let entries = [];
  try {
    entries = await fsp.readdir(config.copilotSessionStateDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const sessionDir = entry.name;
    const eventsPath = path.join(config.copilotSessionStateDir, sessionDir, 'events.jsonl');
    if (!(await pathExists(eventsPath))) continue;

    const workspaceInfo = await readSimpleYaml(
      path.join(config.copilotSessionStateDir, sessionDir, 'workspace.yaml')
    );

    let fileStat;
    try {
      fileStat = await fsp.stat(eventsPath);
    } catch {
      continue;
    }

    const workspaceFingerprint = JSON.stringify([
      workspaceInfo.cwd || '',
      workspaceInfo.summary || '',
      workspaceInfo.created_at || '',
      workspaceInfo.updated_at || '',
    ]);
    const cacheKey = buildSessionMetadataCacheKey('copilot', eventsPath);
    const fingerprint = buildFileFingerprint(fileStat, workspaceFingerprint);
    const cached = getCachedSessionMetadata(cacheKey, fingerprint);
    if (cached) {
      sessions.push(cached);
      continue;
    }

    const metadata = await scanCopilotMetadata(eventsPath, workspaceInfo);
    const projectPath = normalizeProjectPath(metadata.projectPath);

    const session = {
      source: 'copilot',
      sourceLabel: SOURCE_META.copilot.label,
      sourceShortLabel: SOURCE_META.copilot.shortLabel,
      projectPath,
      projectName: displayNameFromPath(projectPath),
      rawSessionId: metadata.rawSessionId,
      firstPrompt: metadata.firstPrompt || workspaceInfo.summary || '',
      summary: workspaceInfo.summary || '',
      messageCount: metadata.messageCount,
      created: metadata.created || workspaceInfo.created_at || fileStat.birthtime.toISOString(),
      modified: workspaceInfo.updated_at || fileStat.mtime.toISOString(),
      gitBranch: metadata.gitBranch || '',
      model: metadata.model || '',
      sessionId: encodeToken({
        source: 'copilot',
        projectPath,
        sessionDir,
        rawSessionId: metadata.rawSessionId,
      }),
    };

    setCachedSessionMetadata(cacheKey, fingerprint, session);
    sessions.push(session);
  }

  return sessions;
}

async function collectAllSessions() {
  await ensureSessionTitleOverridesLoaded();
  await ensureClaudeProvenanceLoaded();
  await ensureClaudeProfilesLoaded();
  await ensureSessionMetadataCacheLoaded();

  const [claude, codex, copilot] = await Promise.all([
    collectClaudeSessions(),
    collectCodexSessions(),
    collectCopilotSessions(),
  ]);

  return [
    ...claude.map(decorateClaudeSessionConfig),
    ...codex,
    ...copilot,
  ].map(applySessionTitleOverride);
}

async function buildSessionsSnapshot() {
  const sessions = await collectAllSessions();
  const projects = buildProjectRows(sessions);
  const sessionsByProject = new Map();
  const sessionsDigestByProject = new Map();

  for (const project of projects) {
    const projectSessions = sessions
      .filter((session) => normalizeProjectPath(session.projectPath) === project.path)
      .sort((a, b) => {
        const dateA = a.modified ? new Date(a.modified).getTime() : 0;
        const dateB = b.modified ? new Date(b.modified).getTime() : 0;
        return dateB - dateA;
      });
    sessionsByProject.set(project.path, projectSessions);
    sessionsDigestByProject.set(project.path, buildSessionDigest(projectSessions));
  }

  const snapshot = {
    builtAt: Date.now(),
    sessions,
    projects,
    projectsDigest: buildProjectDigest(projects),
    sessionsByProject,
    sessionsDigestByProject,
  };

  sessionsSnapshotCache = snapshot;
  await persistSessionMetadataCache();
  return snapshot;
}

async function getSessionsSnapshot(force = false) {
  if (
    !force &&
    sessionsSnapshotCache &&
    Date.now() - sessionsSnapshotCache.builtAt < SESSION_SNAPSHOT_TTL_MS
  ) {
    return sessionsSnapshotCache;
  }

  return buildSessionsSnapshot();
}

async function handleGetClaudeProfiles(req, res) {
  await ensureClaudeProfilesLoaded();
  const profiles = Object.values(claudeProfilesCache?.byName || {}).map((profile) => ({
    name: profile.name,
    label: profile.label,
    anthropicModel: profile.anthropicModel,
    baseUrl: profile.baseUrl,
    description: profile.description,
  }));
  sendJSON(res, profiles);
}

function buildProjectRows(sessions) {
  const projectMap = new Map();

  for (const session of sessions) {
    const projectPath = normalizeProjectPath(session.projectPath);
    if (!projectMap.has(projectPath)) {
      projectMap.set(projectPath, {
        name: displayNameFromPath(projectPath),
        dirName: encodeToken({ projectPath }),
        path: projectPath,
        sessionCount: 0,
        sourceCounts: {},
        sources: [],
        latestModified: 0,
      });
    }

    const row = projectMap.get(projectPath);
    row.sessionCount++;
    row.sourceCounts[session.source] = (row.sourceCounts[session.source] || 0) + 1;
    row.sources = Object.keys(row.sourceCounts).sort();
    row.latestModified = Math.max(
      row.latestModified,
      session.modified ? new Date(session.modified).getTime() : 0
    );
  }

  return [...projectMap.values()].sort((a, b) => {
    if (b.latestModified !== a.latestModified) {
      return b.latestModified - a.latestModified;
    }
    return a.name.localeCompare(b.name);
  });
}

function buildDraftSession(projectPath, source) {
  const rawSessionId = source === 'codex' ? '' : randomUUID();
  const draftId = randomUUID();
  const label = SOURCE_META[source] || { label: source, shortLabel: source.slice(0, 2).toUpperCase() };
  const now = new Date().toISOString();

  return {
    source,
    sourceLabel: label.label,
    sourceShortLabel: label.shortLabel,
    projectPath,
    projectDir: encodeToken({ projectPath }),
    projectName: displayNameFromPath(projectPath),
    rawSessionId,
    firstPrompt: `(new ${label.label} session)`,
    summary: 'Draft session. Send a message to create it.',
    messageCount: 0,
    created: now,
    modified: now,
    gitBranch: '',
    model: '',
    isDraft: true,
    sessionId: encodeToken({
      source,
      projectPath,
      draft: true,
      rawSessionId,
      draftId,
    }),
  };
}

function parseClaudeAssistantContent(content) {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(content) }];

  return content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text || '' };
    }
    if (block.type === 'tool_use') {
      const inputSummary = truncateText(
        typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
        1500
      );
      return { type: 'tool_use', name: block.name || 'unknown', input: inputSummary };
    }
    if (block.type === 'tool_result') {
      const result = Array.isArray(block.content)
        ? block.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text || '')
            .join('\n')
        : normalizeText(block.content);
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id || '',
        content: truncateText(result, 1500),
      };
    }
    return { type: 'text', text: truncateText(JSON.stringify(block), 500) };
  });
}

function parseClaudeToolResults(content) {
  if (!content) return [];
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: truncateText(normalizeText(content), 1500) }];
  }

  return content.map((block) => {
    if (block.type === 'tool_result') {
      const result = Array.isArray(block.content)
        ? block.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text || '')
            .join('\n')
        : normalizeText(block.content);
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id || '',
        content: truncateText(result, 1500),
      };
    }
    return { type: 'text', text: truncateText(JSON.stringify(block), 500) };
  });
}

async function parseClaudeMessages(filePath) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    const messages = [];

    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;

      const type = obj.type;
      if (type !== 'user' && type !== 'assistant' && type !== 'system') return;

      let effectiveType = type;
      const content = obj.message?.content;

      if (type === 'user' && Array.isArray(content) && content[0]?.type === 'tool_result') {
        effectiveType = 'tool_result';
      }
      if (type === 'system' && obj.subtype === 'compact_boundary') {
        effectiveType = 'compact_boundary';
      }
      if (
        type === 'user' &&
        effectiveType === 'user' &&
        typeof content === 'string' &&
        content.startsWith('This session is being continued from a previous conversation')
      ) {
        effectiveType = 'context_summary';
      }

      const base = {
        type: effectiveType,
        source: 'claude',
        sourceLabel: SOURCE_META.claude.label,
        timestamp: obj.timestamp || '',
        uuid: obj.uuid || '',
        roleLabel: effectiveType === 'assistant' ? 'CLAUDE' : '',
      };

      if (effectiveType === 'user') {
        const skillContext = parseClaudeSkillContext(content);
        if (skillContext) {
          messages.push({
            ...base,
            type: 'system',
            content: skillContext.text,
          });
          return;
        }

        if (typeof content === 'string') {
          const wrapper = parseClaudeWrapper(content);
          if (wrapper?.kind === 'command') {
            messages.push({
              ...base,
              type: 'command',
              roleLabel: 'COMMAND',
              content: wrapper.text,
            });
            return;
          }
          if (wrapper?.kind === 'local_stdout') {
            messages.push({
              ...base,
              type: 'tool_result',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: obj.uuid || '',
                  content: truncateText(wrapper.text, 1500),
                },
              ],
            });
            return;
          }
          if (wrapper?.kind === 'local_stderr') {
            messages.push({
              ...base,
              type: 'tool_result',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: obj.uuid || '',
                  content: truncateText(`stderr\n${wrapper.text}`, 1500),
                },
              ],
            });
            return;
          }
          if (wrapper?.kind === 'local_status') {
            messages.push({
              ...base,
              type: 'system',
              content: truncateText(wrapper.text, 500),
            });
            return;
          }
          if (wrapper?.kind === 'local_caveat') {
            messages.push({
              ...base,
              type: 'system',
              content: 'Local command transcript follows',
            });
            return;
          }
        }

        messages.push({
          ...base,
          content: normalizeText(content),
        });
        return;
      }

      if (effectiveType === 'assistant') {
        messages.push({
          ...base,
          model: obj.message?.model || '',
          content: parseClaudeAssistantContent(content),
        });
        return;
      }

      if (effectiveType === 'tool_result') {
        messages.push({
          ...base,
          content: parseClaudeToolResults(content),
        });
        return;
      }

      if (effectiveType === 'compact_boundary') {
        messages.push({
          ...base,
          content: '--- Context compacted ---',
        });
        return;
      }

      if (effectiveType === 'context_summary') {
        messages.push({
          ...base,
          content: normalizeText(content),
        });
        return;
      }

      messages.push({
        ...base,
        subtype: obj.subtype || '',
        content: normalizeText(content),
      });
    });

    rl.on('close', () => resolve(messages));
    rl.on('error', reject);
  });
}

function parseCodexAssistantBlocks(content) {
  if (!Array.isArray(content)) {
    if (!content) return [];
    return [{ type: 'text', text: normalizeText(content) }];
  }

  return content
    .map((block) => {
      if (block.type === 'output_text') {
        return { type: 'text', text: block.text || '' };
      }
      if (block.type === 'refusal') {
        return { type: 'text', text: block.refusal || '' };
      }
      return { type: 'text', text: truncateText(JSON.stringify(block), 500) };
    })
    .filter((block) => block.text);
}

function makeAssistantToolMessage(source, timestamp, uuid, roleLabel, toolName, input) {
  return {
    type: 'assistant',
    source,
    sourceLabel: SOURCE_META[source].label,
    timestamp,
    uuid,
    roleLabel,
    content: [
      {
        type: 'tool_use',
        name: toolName || 'tool',
        input: truncateText(typeof input === 'string' ? input : JSON.stringify(input || {}), 2500),
      },
    ],
  };
}

function makeToolResultMessage(source, timestamp, uuid, content) {
  return {
    type: 'tool_result',
    source,
    sourceLabel: SOURCE_META[source].label,
    timestamp,
    uuid,
    content: [
      {
        type: 'tool_result',
        tool_use_id: uuid || '',
        content: truncateText(content, 2500),
      },
    ],
  };
}

function parseCodexToolResultOutput(payload) {
  if (payload.type === 'function_call_output') {
    return normalizeText(payload.output);
  }

  if (payload.type === 'custom_tool_call_output') {
    const parsed = safeJsonParse(payload.output);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.output === 'string') return parsed.output;
      return JSON.stringify(parsed);
    }
    return normalizeText(payload.output);
  }

  return normalizeText(payload.output);
}

async function parseCodexMessages(filePath) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    const messages = [];
    let currentModel = '';

    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;

      if (obj.type === 'turn_context') {
        currentModel = obj.payload?.model || currentModel;
        return;
      }

      if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
        messages.push({
          type: 'user',
          source: 'codex',
          sourceLabel: SOURCE_META.codex.label,
          timestamp: obj.timestamp || '',
          uuid: '',
          content: normalizeText(obj.payload?.message),
        });
        return;
      }

      if (obj.type !== 'response_item') return;

      const payload = obj.payload || {};
      const timestamp = obj.timestamp || '';

      if (payload.type === 'message' && payload.role === 'assistant') {
        messages.push({
          type: 'assistant',
          source: 'codex',
          sourceLabel: SOURCE_META.codex.label,
          timestamp,
          uuid: '',
          model: currentModel,
          roleLabel: 'CODEX',
          content: parseCodexAssistantBlocks(payload.content),
        });
        return;
      }

      if (payload.type === 'function_call') {
        messages.push(
          makeAssistantToolMessage(
            'codex',
            timestamp,
            payload.call_id || '',
            'CODEX',
            payload.name,
            payload.arguments
          )
        );
        return;
      }

      if (payload.type === 'custom_tool_call') {
        messages.push(
          makeAssistantToolMessage(
            'codex',
            timestamp,
            payload.call_id || '',
            'CODEX',
            payload.name,
            payload.input
          )
        );
        return;
      }

      if (payload.type === 'web_search_call') {
        const searchInput =
          payload.action?.query ||
          payload.action?.queries ||
          payload.action ||
          '';
        messages.push(
          makeAssistantToolMessage(
            'codex',
            timestamp,
            payload.call_id || '',
            'CODEX',
            'web_search',
            searchInput
          )
        );
        return;
      }

      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        messages.push(
          makeToolResultMessage(
            'codex',
            timestamp,
            payload.call_id || '',
            parseCodexToolResultOutput(payload)
          )
        );
      }
    });

    rl.on('close', () => resolve(messages));
    rl.on('error', reject);
  });
}

async function parseCopilotMessages(eventsPath) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(eventsPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    const messages = [];
    const toolNamesById = new Map();
    let currentModel = '';

    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;

      const type = obj.type;
      const data = obj.data || {};
      const timestamp = obj.timestamp || '';

      if (type === 'session.model_change' || type === 'session.info') {
        if (data.message) {
          currentModel = extractCopilotModel(data.message) || currentModel;
        }
        return;
      }

      if (type === 'user.message') {
        messages.push({
          type: 'user',
          source: 'copilot',
          sourceLabel: SOURCE_META.copilot.label,
          timestamp,
          uuid: obj.id || '',
          content: normalizeText(data.content),
        });
        return;
      }

      if (type === 'assistant.message') {
        const blocks = [];
        if (data.content && data.content.trim()) {
          blocks.push({ type: 'text', text: data.content });
        }

        for (const request of data.toolRequests || []) {
          toolNamesById.set(request.toolCallId || '', request.name || 'tool');
          blocks.push({
            type: 'tool_use',
            name: request.name || 'tool',
            input: truncateText(JSON.stringify(request.arguments || {}), 2500),
          });
        }

        if (blocks.length) {
          messages.push({
            type: 'assistant',
            source: 'copilot',
            sourceLabel: SOURCE_META.copilot.label,
            timestamp,
            uuid: data.messageId || obj.id || '',
            model: currentModel,
            roleLabel: 'COPILOT',
            content: blocks,
          });
        }
        return;
      }

      if (type === 'tool.execution_start') {
        toolNamesById.set(data.toolCallId || '', data.toolName || 'tool');
        return;
      }

      if (type === 'tool.execution_complete') {
        const resultContent =
          data.result?.content ||
          data.result?.detailedContent ||
          data.error?.message ||
          normalizeText(data.result || '');

        messages.push(
          makeToolResultMessage(
            'copilot',
            timestamp,
            data.toolCallId || obj.id || '',
            `${toolNamesById.get(data.toolCallId || '') || 'tool'}\n${resultContent}`
          )
        );
      }
    });

    rl.on('close', () => resolve(messages));
    rl.on('error', reject);
  });
}

async function loadMessagesForLocator(locator) {
  if (!locator || !locator.source) return [];

  const storage = resolveSessionStorage(locator);
  const filePath = storage?.filePath;
  if (!filePath) return [];

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return [];
  }

  const cacheKey = buildSessionMetadataCacheKey(`${locator.source}-messages`, filePath);
  const fingerprint = buildFileFingerprint(stat);
  const cached = getMessageCache(cacheKey, fingerprint);
  if (cached) {
    return cached;
  }

  let messages = [];
  if (locator.source === 'claude') {
    messages = await parseClaudeMessages(filePath);
  } else if (locator.source === 'codex') {
    messages = await parseCodexMessages(filePath);
  } else if (locator.source === 'copilot') {
    messages = await parseCopilotMessages(filePath);
  }

  setMessageCache(cacheKey, fingerprint, messages);
  return messages;
}

function resolveSessionStorage(locator) {
  if (!locator || !locator.source) return null;

  if (locator.source === 'claude') {
    return {
      source: 'claude',
      filePath: path.join(
        config.claudeProjectsDir,
        locator.projectDir,
        `${locator.rawSessionId}.jsonl`
      ),
      sessionsIndexPath: path.join(
        config.claudeProjectsDir,
        locator.projectDir,
        'sessions-index.json'
      ),
      rawSessionId: locator.rawSessionId,
    };
  }

  if (locator.source === 'codex') {
    return {
      source: 'codex',
      filePath: path.join(config.codexSessionsDir, locator.relativePath),
    };
  }

  if (locator.source === 'copilot') {
    return {
      source: 'copilot',
      dirPath: path.join(config.copilotSessionStateDir, locator.sessionDir),
      filePath: path.join(config.copilotSessionStateDir, locator.sessionDir, 'events.jsonl'),
    };
  }

  return null;
}

async function cleanupClaudeSessionIndex(indexPath, rawSessionId) {
  try {
    const raw = await fsp.readFile(indexPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries)) return;
    data.entries = data.entries.filter((entry) => entry.sessionId !== rawSessionId);
    await fsp.writeFile(indexPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch {
    // ignore index cleanup failure
  }
}

async function handleDeleteSession(req, res, projectToken, sessionToken) {
  const project = decodeToken(projectToken);
  const locator = decodeToken(sessionToken);

  if (!project?.projectPath || !locator?.projectPath) {
    sendError(res, 'Invalid session locator', 400);
    return;
  }

  if (project.projectPath !== locator.projectPath) {
    sendError(res, 'Session does not belong to the selected project', 400);
    return;
  }

  if (locator.draft) {
    sendJSON(res, { ok: true, source: locator.source, draft: true });
    return;
  }

  const storage = resolveSessionStorage(locator);
  if (!storage) {
    sendError(res, 'Unsupported session source', 400);
    return;
  }

  try {
    let trashedTo = '';
    if (storage.filePath) {
      if (!(await pathExists(storage.filePath))) {
        sendError(res, 'Session file not found', 404);
        return;
      }
      trashedTo = await movePathToTrash(storage.filePath, storage.source);
    } else if (storage.dirPath) {
      if (!(await pathExists(storage.dirPath))) {
        sendError(res, 'Session directory not found', 404);
        return;
      }
      trashedTo = await movePathToTrash(storage.dirPath, storage.source);
    }

    if (storage.source === 'claude' && storage.sessionsIndexPath && storage.rawSessionId) {
      await cleanupClaudeSessionIndex(storage.sessionsIndexPath, storage.rawSessionId);
    }

    if (storage.filePath) {
      sessionMetadataCache.delete(buildSessionMetadataCacheKey(storage.source, storage.filePath));
      invalidateMessageCache(buildSessionMetadataCacheKey(`${storage.source}-messages`, storage.filePath));
      sessionMetadataCacheDirty = true;
    }
    invalidateSessionsSnapshotCache();
    await persistSessionMetadataCache();

    sendJSON(res, {
      ok: true,
      source: storage.source,
      trashedTo,
    });
  } catch (err) {
    sendError(res, 'Failed to delete session: ' + err.message);
  }
}

async function handleGetProjects(req, res) {
  try {
    const snapshot = await getSessionsSnapshot();
    sendJSON(res, snapshot.projects);
  } catch (err) {
    sendError(res, 'Failed to build project list: ' + err.message);
  }
}

async function handleGetProjectsDigest(req, res) {
  try {
    const snapshot = await getSessionsSnapshot();
    sendJSON(res, snapshot.projectsDigest);
  } catch (err) {
    sendError(res, 'Failed to build project digest: ' + err.message);
  }
}

async function handleGetSessions(req, res, projectToken) {
  const decoded = decodeToken(projectToken);
  if (!decoded?.projectPath) {
    sendError(res, 'Invalid project token', 400);
    return;
  }

  try {
    const snapshot = await getSessionsSnapshot();
    const sessions = snapshot.sessionsByProject.get(decoded.projectPath) || [];
    sendJSON(res, sessions);
  } catch (err) {
    sendError(res, 'Failed to read sessions: ' + err.message);
  }
}

async function handleGetSessionsDigest(req, res, projectToken) {
  const decoded = decodeToken(projectToken);
  if (!decoded?.projectPath) {
    sendError(res, 'Invalid project token', 400);
    return;
  }

  try {
    const snapshot = await getSessionsSnapshot();
    const digest = snapshot.sessionsDigestByProject.get(decoded.projectPath) || [];
    sendJSON(res, digest);
  } catch (err) {
    sendError(res, 'Failed to read sessions digest: ' + err.message);
  }
}

async function handleGetMessages(req, res, projectToken, sessionToken, query) {
  const project = decodeToken(projectToken);
  const locator = decodeToken(sessionToken);

  if (!project?.projectPath || !locator?.projectPath) {
    sendError(res, 'Invalid session locator', 400);
    return;
  }

  if (project.projectPath !== locator.projectPath) {
    sendError(res, 'Session does not belong to the selected project', 400);
    return;
  }

  const offset = parseInt(query.get('offset') || '0', 10);
  const limit = parseInt(query.get('limit') || '50', 10);
  const direction = query.get('direction') || 'newest';

  try {
    const allMessages = await loadMessagesForLocator(locator);
    const total = allMessages.length;

    let sliced = [];
    let hasMore = false;
    if (direction === 'newest') {
      const start = Math.max(0, total - offset - limit);
      const end = Math.max(0, total - offset);
      sliced = allMessages.slice(start, end);
      hasMore = start > 0;
    } else {
      sliced = allMessages.slice(offset, offset + limit);
      hasMore = offset + limit < total;
    }

    sendJSON(res, { messages: sliced, total, hasMore });
  } catch (err) {
    sendError(res, 'Failed to read messages: ' + err.message);
  }
}

async function handleCreateDraftSession(req, res, projectToken) {
  const decoded = decodeToken(projectToken);
  if (!decoded?.projectPath) {
    sendError(res, 'Invalid project token', 400);
    return;
  }

  let raw = '';
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  } catch {
    sendError(res, 'Invalid request body', 400);
    return;
  }

  const body = safeJsonParse(raw || '{}') || {};
  const source = typeof body.source === 'string' ? body.source : '';
  const capabilities = await getInteractionCapabilities(config);
  if (!capabilities[source]?.enabled) {
    sendError(res, `Source unavailable: ${source}`, 400);
    return;
  }

  sendJSON(res, buildDraftSession(decoded.projectPath, source));
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      const parsed = safeJsonParse(raw);
      if (!parsed || typeof parsed !== 'object') {
        reject(new Error('Invalid JSON body'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

async function handleRenameSession(req, res, projectToken, sessionToken) {
  const project = decodeToken(projectToken);
  const locator = decodeToken(sessionToken);

  if (!project?.projectPath || !locator?.projectPath) {
    sendError(res, 'Invalid session locator', 400);
    return;
  }

  if (project.projectPath !== locator.projectPath) {
    sendError(res, 'Session does not belong to the selected project', 400);
    return;
  }

  if (locator.draft) {
    sendError(res, 'Draft sessions are renamed client-side only', 400);
    return;
  }

  const key = buildSessionTitleOverrideKey(locator);
  if (!key) {
    sendError(res, 'This session cannot be renamed', 400);
    return;
  }

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, err.message || 'Invalid request body', 400);
    return;
  }

  await ensureSessionTitleOverridesLoaded();
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  if (title) {
    sessionTitleOverrides[key] = title;
  } else {
    delete sessionTitleOverrides[key];
  }

  try {
    await persistSessionTitleOverrides();
  } catch (err) {
    sendError(res, 'Failed to save session title: ' + err.message);
    return;
  }

  invalidateSessionsSnapshotCache();

  sendJSON(res, {
    ok: true,
    customTitle: title,
    cleared: !title,
  });
}

async function handleRequest(req, res) {
  const urlObj = new URL(req.url, `http://localhost:${config.port}`);
  const pathname = urlObj.pathname;
  const query = urlObj.searchParams;

  if (pathname === '/api/capabilities' && req.method === 'GET') {
    return sendJSON(res, await getInteractionCapabilities(config));
  }

  if (pathname === '/api/claude-profiles' && req.method === 'GET') {
    return handleGetClaudeProfiles(req, res);
  }

  if (pathname === '/api/projects' && req.method === 'GET') {
    return handleGetProjects(req, res);
  }

  if (pathname === '/api/projects-digest' && req.method === 'GET') {
    return handleGetProjectsDigest(req, res);
  }

  const sessionsMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionsMatch && req.method === 'GET') {
    return handleGetSessions(req, res, decodeURIComponent(sessionsMatch[1]));
  }

  const sessionsDigestMatch = pathname.match(/^\/api\/sessions-digest\/([^/]+)$/);
  if (sessionsDigestMatch && req.method === 'GET') {
    return handleGetSessionsDigest(req, res, decodeURIComponent(sessionsDigestMatch[1]));
  }

  const messagesMatch = pathname.match(/^\/api\/messages\/([^/]+)\/([^/]+)$/);
  if (messagesMatch && req.method === 'GET') {
    return handleGetMessages(
      req,
      res,
      decodeURIComponent(messagesMatch[1]),
      decodeURIComponent(messagesMatch[2]),
      query
    );
  }

  const draftMatch = pathname.match(/^\/api\/draft-session\/([^/]+)$/);
  if (draftMatch && req.method === 'POST') {
    return handleCreateDraftSession(req, res, decodeURIComponent(draftMatch[1]));
  }

  const renameMatch = pathname.match(/^\/api\/session-title\/([^/]+)\/([^/]+)$/);
  if (renameMatch && req.method === 'PUT') {
    return handleRenameSession(
      req,
      res,
      decodeURIComponent(renameMatch[1]),
      decodeURIComponent(renameMatch[2]),
    );
  }

  const deleteMatch = pathname.match(/^\/api\/session\/([^/]+)\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    return handleDeleteSession(
      req,
      res,
      decodeURIComponent(deleteMatch[1]),
      decodeURIComponent(deleteMatch[2]),
    );
  }

  const interactMatch = pathname.match(/^\/api\/interact\/([^/]+)\/([^/]+)$/);
  if (interactMatch && req.method === 'POST') {
    const project = decodeToken(decodeURIComponent(interactMatch[1]));
    const locator = decodeToken(decodeURIComponent(interactMatch[2]));

    if (!project?.projectPath || !locator?.projectPath) {
      sendError(res, 'Invalid interaction target', 400);
      return;
    }

    return handleInteractionRequest(req, res, {
      project,
      locator,
      config,
    });
  }

  return serveStatic(req, res);
}

const server = http.createServer(handleRequest);

server.listen(config.port, () => {
  const banner = `
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551     Session History Dashboard                    \u2551
\u2551                                                  \u2551
\u2551   Dashboard: http://localhost:${String(config.port).padEnd(21)}\u2551
\u2551   Claude:   ${config.claudeProjectsDir.padEnd(36).slice(0, 36)}\u2551
\u2551   Codex:    ${config.codexSessionsDir.padEnd(36).slice(0, 36)}\u2551
\u2551   Copilot:  ${config.copilotSessionStateDir.padEnd(36).slice(0, 36)}\u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d`;
  console.log(banner);
});
