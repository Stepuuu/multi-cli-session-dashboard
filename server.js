import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getInteractionCapabilities, handleInteractionRequest } from './interaction.js';
import { loadRuntimeConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const SOURCE_META = {
  claude: { label: 'Claude', shortLabel: 'CC' },
  codex: { label: 'Codex', shortLabel: 'CX' },
  copilot: { label: 'Copilot', shortLabel: 'CP' },
};

const CLAUDE_SYNTHETIC_WARMUP_PROMPT = 'Warmup';
const CLAUDE_SYNTHETIC_SUMMARY_PREFIX = 'Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.';
const CLAUDE_SYNTHETIC_JUDGE_PREFIX = 'Analyze this conversation and determine: Does the assistant have more autonomous work to do RIGHT NOW?';

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
const SESSION_SNAPSHOT_TTL_MS = 10000;
const MESSAGE_CACHE_LIMIT = 32;
const LARGE_SESSION_FAST_PATH_BYTES = 2 * 1024 * 1024;
const RECENT_TAIL_LINES_INITIAL = 2000;
const RECENT_TAIL_LINES_MAX = 16000;
let sessionTitleOverridesLoaded = false;
let sessionTitleOverrides = {};
let claudeProvenanceLoaded = false;
let claudeSessionProvenance = {};
let claudeProfilesCache = null;
let claudeProfilesFilePath = '';
let claudeProfilesFingerprint = '';
let sessionMetadataCacheLoaded = false;
let sessionMetadataCacheDirty = false;
const sessionMetadataCache = new Map();
let sessionsSnapshotCache = null;
let sessionsSnapshotRefreshPromise = null;
const messageParseCache = new Map();
const recentMessageCache = new Map();
let resolvedCodexStateDbPath = '';
let codexStateDbPathResolved = false;

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

function isAllowedLoopbackOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1'
    );
  } catch {
    return false;
  }
}

function buildCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!isAllowedLoopbackOrigin(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function buildHealthPayload() {
  return {
    ok: true,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
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
  sessionsSnapshotRefreshPromise = null;
}

function buildSessionMetadataCacheKey(source, filePath) {
  return `${source}:${filePath}`;
}

function buildFileFingerprint(stat, extra = '') {
  const extraPart = extra ? `:${extra}` : '';
  return `${Math.floor(stat.mtimeMs)}:${stat.size}${extraPart}`;
}

function emptyClaudeProfilesCache() {
  return { byName: {}, byModel: new Map() };
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

function getRecentMessageCache(cacheKey, fingerprint) {
  const cached = recentMessageCache.get(cacheKey);
  if (!cached || cached.fingerprint !== fingerprint) return null;
  recentMessageCache.delete(cacheKey);
  recentMessageCache.set(cacheKey, cached);
  return cached.result;
}

function setRecentMessageCache(cacheKey, fingerprint, result) {
  if (recentMessageCache.has(cacheKey)) {
    recentMessageCache.delete(cacheKey);
  }
  recentMessageCache.set(cacheKey, { fingerprint, result });

  while (recentMessageCache.size > MESSAGE_CACHE_LIMIT) {
    const firstKey = recentMessageCache.keys().next().value;
    if (!firstKey) break;
    recentMessageCache.delete(firstKey);
  }
}

function invalidateRecentMessageCache(cacheKey) {
  if (!cacheKey) return;
  recentMessageCache.delete(cacheKey);
}

function buildProjectDigest(projects) {
  return projects.map((project) => ({
    dirName: project.dirName,
    sessionCount: project.sessionCount,
    archivedSessionCount: project.archivedSessionCount || 0,
    totalSessionCount: project.totalSessionCount || project.sessionCount || 0,
    latestModified: project.latestModified || 0,
    latestVisibleModified: project.latestVisibleModified || 0,
    sourceCounts: project.sourceCounts || {},
  }));
}

function buildSessionDigest(sessions) {
  return sessions.map((session) => ({
    sessionId: session.sessionId,
    source: session.source,
    rawSessionId: session.rawSessionId || '',
    forkedFromId: session.forkedFromId || '',
    modified: session.modified || '',
    messageCount: session.messageCount || 0,
    model: session.model || '',
    title: session.customTitle || session.firstPrompt || '',
    archived: !!session.archived,
    archivedAt: session.archivedAt || '',
  }));
}

function buildCodexSubagentParentKey(projectPath, parentThreadId) {
  return JSON.stringify({
    projectPath: normalizeProjectPath(projectPath || ''),
    parentThreadId: parentThreadId || '',
  });
}

function compareTimestampedItems(left, right) {
  const leftTime = left?.timestamp ? new Date(left.timestamp).getTime() : Number.NaN;
  const rightTime = right?.timestamp ? new Date(right.timestamp).getTime() : Number.NaN;
  const leftHasTime = Number.isFinite(leftTime);
  const rightHasTime = Number.isFinite(rightTime);

  if (leftHasTime && rightHasTime && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftHasTime !== rightHasTime) {
    return leftHasTime ? -1 : 1;
  }

  const leftOrder = Number.isFinite(left?._mergeOrder) ? left._mergeOrder : 0;
  const rightOrder = Number.isFinite(right?._mergeOrder) ? right._mergeOrder : 0;
  return leftOrder - rightOrder;
}

function compactStructuredValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return truncateText(value, 400);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return truncateText(normalizeText(value), 400);

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactStructuredValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 12)) {
      result[key] = compactStructuredValue(entry, depth + 1);
    }
    return result;
  }

  return truncateText(normalizeText(value), 400);
}

function maybeParseJsonString(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!/^[{\[]/.test(trimmed)) return value;
  const parsed = safeJsonParse(trimmed);
  return parsed == null ? value : parsed;
}

function normalizeToolPayload(value) {
  if (typeof value === 'string') {
    return maybeParseJsonString(value);
  }
  return value;
}

function summarizeToolPayload(toolName, value) {
  const normalized = normalizeToolPayload(value);
  if (typeof normalized === 'string') {
    return truncateText(normalized.split('\n').find(Boolean) || normalized, 160);
  }

  if (Array.isArray(normalized)) {
    return `${normalized.length} item${normalized.length === 1 ? '' : 's'}`;
  }

  if (normalized && typeof normalized === 'object') {
    const candidates = [
      normalized.command,
      normalized.cmd,
      normalized.query,
      normalized.pattern,
      normalized.path,
      normalized.file_path,
      normalized.filePath,
      normalized.description,
      normalized.prompt,
      normalized.subject,
      normalized.taskId ? `task ${normalized.taskId}` : '',
      normalized.owner ? `owner ${normalized.owner}` : '',
      normalized.status ? `status ${normalized.status}` : '',
    ].filter(Boolean);
    if (candidates.length > 0) {
      return truncateText(String(candidates[0]), 160);
    }

    const keys = Object.keys(normalized);
    if (keys.length) {
      return truncateText(`${toolName || 'tool'} · ${keys.slice(0, 4).join(', ')}`, 160);
    }
  }

  return truncateText(normalizeText(normalized), 160);
}

function summarizeStructuredToolResult(value) {
  if (!value || typeof value !== 'object') return '';

  if (value.status === 'teammate_spawned' && (value.name || value.agent_id || value.teammate_id)) {
    return `Spawned ${value.name || value.agent_id || value.teammate_id}`;
  }
  if (value.task?.id && value.task?.subject) {
    return `Task #${value.task.id}: ${value.task.subject}`;
  }
  if (value.taskId && value.updatedFields) {
    const fields = Array.isArray(value.updatedFields) ? value.updatedFields.join(', ') : 'updated';
    return `Task #${value.taskId}: ${fields}`;
  }
  if (typeof value.success === 'boolean') {
    return value.success ? 'Operation succeeded' : 'Operation failed';
  }
  if (value.agent_id || value.teammate_id) {
    return String(value.agent_id || value.teammate_id);
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return '';
  const preview = keys
    .slice(0, 3)
    .map((key) => `${key}=${truncateText(normalizeText(value[key]), 60)}`)
    .join(' · ');
  return truncateText(preview, 180);
}

function buildCodexTokenUsageSummary(info) {
  const usage = info?.last_token_usage || info?.lastTokenUsage || null;
  if (!usage) return '';
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const cachedInputTokens = Number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  const usedTokens = Number(usage.total_tokens ?? usage.totalTokens ?? (inputTokens + outputTokens));
  const contextWindow = Number(info?.model_context_window ?? info?.modelContextWindow ?? 0);

  const parts = [];
  if (contextWindow > 0 && usedTokens > 0) {
    parts.push(`Context ${usedTokens}/${contextWindow}`);
  }
  if (inputTokens > 0) {
    parts.push(`Input ${inputTokens}`);
  }
  if (cachedInputTokens > 0) {
    parts.push(`Cached ${cachedInputTokens}`);
  }
  if (outputTokens > 0) {
    parts.push(`Output ${outputTokens}`);
  }
  return parts.join(' · ');
}

function nextMessageOrder(state) {
  state._messageOrder = (state._messageOrder || 0) + 1;
  return state._messageOrder;
}

function parseTimestampMs(value) {
  if (!value) return Number.NaN;
  const date = new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function normalizeEpochTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const millis = numeric < 1e12 ? numeric * 1000 : numeric;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

async function resolveCodexStateDbPath() {
  if (codexStateDbPathResolved) return resolvedCodexStateDbPath;
  codexStateDbPathResolved = true;

  if (config.codexStateDbPath && existsSync(config.codexStateDbPath)) {
    resolvedCodexStateDbPath = config.codexStateDbPath;
    return resolvedCodexStateDbPath;
  }

  const codexHomeDir = path.dirname(config.codexSessionsDir);
  try {
    const entries = await fsp.readdir(codexHomeDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const match = entry.name.match(/^state_(\d+)\.sqlite$/);
        if (!match) return null;
        return {
          version: Number(match[1]),
          filePath: path.join(codexHomeDir, entry.name),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.version - a.version);

    resolvedCodexStateDbPath = candidates[0]?.filePath || '';
  } catch {
    resolvedCodexStateDbPath = '';
  }

  return resolvedCodexStateDbPath;
}

async function readCodexThreadStateMap() {
  const dbPath = await resolveCodexStateDbPath();
  if (!dbPath) return new Map();

  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      [
        '-readonly',
        '-tabs',
        dbPath,
        "SELECT id, archived, COALESCE(archived_at, '') FROM threads;",
      ],
      {
        maxBuffer: 1024 * 1024 * 8,
      },
    );

    const result = new Map();
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const [id, archivedValue, archivedAtValue] = line.split('\t');
      if (!id) continue;
      result.set(id, {
        archived: archivedValue === '1',
        archivedAt: normalizeEpochTimestamp(archivedAtValue),
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

function applyCodexThreadState(session, threadStateMap) {
  if (!session) return session;
  const threadState = threadStateMap.get(session.rawSessionId || '');
  return {
    ...session,
    archived: !!threadState?.archived,
    archivedAt: threadState?.archivedAt || '',
  };
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
    const label = name.toUpperCase();
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
  return '';
}

async function ensureClaudeProfilesLoaded() {
  try {
    const realProjectsDir = await fsp.realpath(config.claudeProjectsDir);
    const modelsFile = path.join(path.dirname(path.dirname(realProjectsDir)), '.models.json');
    const stat = await fsp.stat(modelsFile);
    const fingerprint = buildFileFingerprint(stat);

    if (
      claudeProfilesCache &&
      claudeProfilesFilePath === modelsFile &&
      claudeProfilesFingerprint === fingerprint
    ) {
      return;
    }

    const raw = await fsp.readFile(modelsFile, 'utf-8');
    claudeProfilesCache = parseClaudeModelsJson(raw);
    claudeProfilesFilePath = modelsFile;
    claudeProfilesFingerprint = fingerprint;
  } catch {
    claudeProfilesCache = emptyClaudeProfilesCache();
    claudeProfilesFilePath = '';
    claudeProfilesFingerprint = '';
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

function hasNonEmptyText(value) {
  return normalizeText(value).trim().length > 0;
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
  if (typeof text !== 'string' || typeof tag !== 'string' || !tag) return '';
  const lowerText = text.toLowerCase();
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const lowerOpenTag = openTag.toLowerCase();
  const lowerCloseTag = closeTag.toLowerCase();
  const startIndex = lowerText.indexOf(lowerOpenTag);
  if (startIndex === -1) return '';
  const contentStart = startIndex + openTag.length;
  const endIndex = lowerText.indexOf(lowerCloseTag, contentStart);
  if (endIndex === -1) return '';
  return text.slice(contentStart, endIndex).trim();
}

function isClaudeSyntheticPrompt(text) {
  const prompt = typeof text === 'string' ? text.trim() : '';
  if (!prompt) return false;
  return prompt === CLAUDE_SYNTHETIC_WARMUP_PROMPT
    || prompt.startsWith(CLAUDE_SYNTHETIC_SUMMARY_PREFIX)
    || prompt.startsWith(CLAUDE_SYNTHETIC_JUDGE_PREFIX);
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
  const trimmed = projectPath.trim().replace(/\/+$/, '');
  if (!trimmed) return '(unknown)';
  return resolveProjectPathAlias(trimmed);
}

function resolveProjectPathAlias(projectPath) {
  if (!projectPath || projectPath === '(unknown)') return '(unknown)';
  if (existsSync(projectPath)) return projectPath;

  const parts = projectPath.split('/').filter(Boolean);
  if (!parts.length) return projectPath;

  const queue = [parts];
  const seen = new Set([parts.join('/')]);
  let steps = 0;
  const maxStates = 256;

  while (queue.length && steps < maxStates) {
    const current = queue.shift();
    steps++;
    const candidatePath = '/' + current.join('/');
    if (existsSync(candidatePath)) {
      return candidatePath;
    }

    if (current.length < 2) continue;

    for (let i = 0; i < current.length - 1; i++) {
      for (const joiner of ['_', '-']) {
        const merged = [
          ...current.slice(0, i),
          `${current[i]}${joiner}${current[i + 1]}`,
          ...current.slice(i + 2),
        ];
        const key = merged.join('/');
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(merged);
      }
    }
  }

  return projectPath;
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
        const hydratedCached = {
          ...cached,
          fileSizeBytes: cached.fileSizeBytes || fileStat.size,
        };
        if (!Object.prototype.hasOwnProperty.call(cached, 'fileSizeBytes')) {
          setCachedSessionMetadata(cacheKey, fingerprint, hydratedCached);
        }
        if (!isClaudeSyntheticPrompt(hydratedCached.firstPrompt)) {
          sessions.push(hydratedCached);
        }
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
        fileSizeBytes: fileStat.size,
        sessionId: encodeToken({
          source: 'claude',
          projectPath,
          projectDir: dirName,
          rawSessionId,
        }),
      };

      setCachedSessionMetadata(cacheKey, fingerprint, session);
      if (!isClaudeSyntheticPrompt(session.firstPrompt)) {
        sessions.push(session);
      }
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
    let lastInputTokens = 0;
    let lastCachedInputTokens = 0;
    let lastOutputTokens = 0;
    let lastUsedTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let contextWindowTokens = 0;
    let forkedFromId = '';
    let isSubagentSession = false;
    let parentThreadId = '';
    let agentRole = '';
    let agentNickname = '';
    let depth = 0;
    let completedAt = '';
    let durationMs = 0;
    let sawPrimarySessionMeta = false;

    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;

      if (obj.type === 'session_meta') {
        // Forked/resumed Codex rollouts can include parent thread metadata
        // after the new thread's own session_meta. Only the first one
        // identifies the file's logical session.
        if (!sawPrimarySessionMeta) {
          const subagentSpawn = obj.payload?.source?.subagent?.thread_spawn;
          rawSessionId = obj.payload?.id || rawSessionId;
          forkedFromId = obj.payload?.forked_from_id || forkedFromId;
          projectPath = obj.payload?.cwd || projectPath;
          created = obj.payload?.timestamp || obj.timestamp || created;
          model = obj.payload?.model || model;
          if (subagentSpawn && typeof subagentSpawn === 'object') {
            isSubagentSession = true;
            parentThreadId = typeof subagentSpawn.parent_thread_id === 'string'
              ? subagentSpawn.parent_thread_id
              : '';
            depth = Number.isFinite(Number(subagentSpawn.depth)) ? Number(subagentSpawn.depth) : 0;
            agentRole = typeof subagentSpawn.agent_role === 'string'
              ? subagentSpawn.agent_role
              : '';
            agentNickname = typeof subagentSpawn.agent_nickname === 'string'
              ? subagentSpawn.agent_nickname
              : '';
          }
          if (!agentRole && typeof obj.payload?.agent_role === 'string') {
            agentRole = obj.payload.agent_role;
          }
          if (!agentNickname && typeof obj.payload?.agent_nickname === 'string') {
            agentNickname = obj.payload.agent_nickname;
          }
          sawPrimarySessionMeta = true;
        }
        return;
      }

      if (obj.type === 'turn_context') {
        gitBranch = obj.payload?.git?.branch || gitBranch;
        model = obj.payload?.model || model;
        return;
      }

      if (obj.type === 'event_msg' && obj.payload?.type === 'task_started') {
        const windowSize = Number(obj.payload?.model_context_window ?? obj.payload?.modelContextWindow ?? 0);
        if (Number.isFinite(windowSize) && windowSize > 0) {
          contextWindowTokens = windowSize;
        }
        return;
      }

      if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete') {
        completedAt = normalizeEpochTimestamp(obj.payload?.completed_at) || obj.timestamp || completedAt;
        const duration = Number(obj.payload?.duration_ms ?? 0);
        if (Number.isFinite(duration) && duration > 0) {
          durationMs = duration;
        }
        return;
      }

      if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
        const info = obj.payload?.info || null;
        const usage = info?.last_token_usage || info?.lastTokenUsage || null;
        const totalUsage = info?.total_token_usage || info?.totalTokenUsage || null;
        const inputTokens = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0);
        const cachedInputTokens = Number(usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? 0);
        const outputTokens = Number(usage?.output_tokens ?? usage?.outputTokens ?? 0);
        const usedTokens = Number(usage?.total_tokens ?? usage?.totalTokens ?? (inputTokens + outputTokens));
        const totalInput = Number(totalUsage?.input_tokens ?? totalUsage?.inputTokens ?? 0);
        const totalOutput = Number(totalUsage?.output_tokens ?? totalUsage?.outputTokens ?? 0);
        const windowSize = Number(info?.model_context_window ?? info?.modelContextWindow ?? 0);
        if (Number.isFinite(inputTokens) && inputTokens > 0) {
          lastInputTokens = inputTokens;
          lastCachedInputTokens = Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0;
          lastOutputTokens = Number.isFinite(outputTokens) ? outputTokens : 0;
          lastUsedTokens = Number.isFinite(usedTokens) ? usedTokens : (inputTokens + outputTokens);
        }
        if (Number.isFinite(totalInput) && totalInput > 0) {
          totalInputTokens = totalInput;
        }
        if (Number.isFinite(totalOutput) && totalOutput >= 0) {
          totalOutputTokens = totalOutput;
        }
        if (Number.isFinite(windowSize) && windowSize > 0) {
          contextWindowTokens = windowSize;
        }
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
        forkedFromId,
        projectPath: normalizeProjectPath(projectPath),
        firstPrompt,
        messageCount,
        created,
        gitBranch,
        model,
        lastInputTokens,
        lastCachedInputTokens,
        lastOutputTokens,
        lastUsedTokens,
        totalInputTokens,
        totalOutputTokens,
        contextWindowTokens,
        isSubagentSession,
        parentThreadId,
        agentRole,
        agentNickname,
        depth,
        completedAt,
        durationMs,
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
  const threadStateMap = await readCodexThreadStateMap();

  const sessions = [];
  const hiddenSubagentSessions = [];

  for (const filePath of files) {
    let fileStat;
    try {
      fileStat = await fsp.stat(filePath);
    } catch {
      continue;
    }

    const cacheKey = buildSessionMetadataCacheKey('codex', filePath);
    const fingerprint = buildFileFingerprint(fileStat);
    const relativePath = path.relative(config.codexSessionsDir, filePath);
    const cached = getCachedSessionMetadata(cacheKey, fingerprint);
    const cachedNeedsRefresh = cached && typeof cached.isSubagentSession === 'boolean' && (
      !Object.prototype.hasOwnProperty.call(cached, 'completedAt')
      || !Object.prototype.hasOwnProperty.call(cached, 'durationMs')
      || !Object.prototype.hasOwnProperty.call(cached, 'parentThreadId')
      || !Object.prototype.hasOwnProperty.call(cached, 'agentRole')
      || !Object.prototype.hasOwnProperty.call(cached, 'agentNickname')
      || !Object.prototype.hasOwnProperty.call(cached, 'depth')
    );
    if (cached && typeof cached.isSubagentSession === 'boolean' && !cachedNeedsRefresh) {
      const hydratedCached = {
        ...cached,
        source: 'codex',
        sourceLabel: SOURCE_META.codex.label,
        sourceShortLabel: SOURCE_META.codex.shortLabel,
        projectPath: normalizeProjectPath(cached.projectPath),
        projectName: displayNameFromPath(normalizeProjectPath(cached.projectPath)),
        rawSessionId: cached.rawSessionId || path.basename(filePath, '.jsonl'),
        relativePath: cached.relativePath || relativePath,
        forkedFromId: cached.forkedFromId || '',
        isSubagentSession: !!cached.isSubagentSession,
        parentThreadId: cached.parentThreadId || '',
        agentRole: cached.agentRole || '',
        agentNickname: cached.agentNickname || '',
        depth: cached.depth || 0,
        completedAt: cached.completedAt || '',
        durationMs: cached.durationMs || 0,
        fileSizeBytes: cached.fileSizeBytes || fileStat.size,
        lastInputTokens: cached.lastInputTokens || 0,
        lastCachedInputTokens: cached.lastCachedInputTokens || 0,
        lastOutputTokens: cached.lastOutputTokens || 0,
        lastUsedTokens: cached.lastUsedTokens || 0,
        totalInputTokens: cached.totalInputTokens || 0,
        totalOutputTokens: cached.totalOutputTokens || 0,
        contextWindowTokens: cached.contextWindowTokens || 0,
        sessionId: encodeToken({
          source: 'codex',
          projectPath: normalizeProjectPath(cached.projectPath),
          relativePath,
          rawSessionId: cached.rawSessionId || path.basename(filePath, '.jsonl'),
        }),
      };
      setCachedSessionMetadata(cacheKey, fingerprint, hydratedCached);
      if (cached.isSubagentSession) {
        hiddenSubagentSessions.push(hydratedCached);
        continue;
      }
      sessions.push(applyCodexThreadState(hydratedCached, threadStateMap));
      continue;
    }

    const metadata = await scanCodexMetadata(filePath);
    const projectPath = normalizeProjectPath(metadata.projectPath);

    const baseSession = {
      source: 'codex',
      sourceLabel: SOURCE_META.codex.label,
      sourceShortLabel: SOURCE_META.codex.shortLabel,
      projectPath,
      projectName: displayNameFromPath(projectPath),
      rawSessionId: metadata.rawSessionId,
      relativePath,
      forkedFromId: metadata.forkedFromId || '',
      isSubagentSession: metadata.isSubagentSession || false,
      parentThreadId: metadata.parentThreadId || '',
      agentRole: metadata.agentRole || '',
      agentNickname: metadata.agentNickname || '',
      depth: metadata.depth || 0,
      completedAt: metadata.completedAt || '',
      durationMs: metadata.durationMs || 0,
      firstPrompt: metadata.firstPrompt,
      summary: '',
      messageCount: metadata.messageCount,
      created: metadata.created || fileStat.birthtime.toISOString(),
      modified: fileStat.mtime.toISOString(),
      gitBranch: metadata.gitBranch || '',
      model: metadata.model || '',
      fileSizeBytes: fileStat.size,
      lastInputTokens: metadata.lastInputTokens || 0,
      lastCachedInputTokens: metadata.lastCachedInputTokens || 0,
      lastOutputTokens: metadata.lastOutputTokens || 0,
      lastUsedTokens: metadata.lastUsedTokens || 0,
      totalInputTokens: metadata.totalInputTokens || 0,
      totalOutputTokens: metadata.totalOutputTokens || 0,
      contextWindowTokens: metadata.contextWindowTokens || 0,
      sessionId: encodeToken({
        source: 'codex',
        projectPath,
        relativePath,
        rawSessionId: metadata.rawSessionId,
      }),
    };

    setCachedSessionMetadata(cacheKey, fingerprint, baseSession);
    if (baseSession.isSubagentSession) {
      hiddenSubagentSessions.push(baseSession);
      continue;
    }
    sessions.push(applyCodexThreadState(baseSession, threadStateMap));
  }

  return {
    sessions: dedupeCodexSessions(sessions),
    hiddenSubagentSessions: dedupeCodexSessions(hiddenSubagentSessions),
  };
}

function choosePreferredCodexSession(current, candidate) {
  if (!current) return candidate;

  const currentModified = current.modified ? new Date(current.modified).getTime() : 0;
  const candidateModified = candidate.modified ? new Date(candidate.modified).getTime() : 0;
  if (candidateModified !== currentModified) {
    return candidateModified > currentModified ? candidate : current;
  }

  const currentMessageCount = current.messageCount || 0;
  const candidateMessageCount = candidate.messageCount || 0;
  if (candidateMessageCount !== currentMessageCount) {
    return candidateMessageCount > currentMessageCount ? candidate : current;
  }

  return candidate;
}

function dedupeCodexSessions(sessions) {
  const deduped = new Map();

  for (const session of sessions) {
    const key = JSON.stringify({
      source: session.source,
      projectPath: normalizeProjectPath(session.projectPath),
      rawSessionId: session.rawSessionId || '',
    });
    const existing = deduped.get(key);
    deduped.set(key, choosePreferredCodexSession(existing, session));
  }

  return Array.from(deduped.values());
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
      const hydratedCached = {
        ...cached,
        fileSizeBytes: cached.fileSizeBytes || fileStat.size,
      };
      if (!Object.prototype.hasOwnProperty.call(cached, 'fileSizeBytes')) {
        setCachedSessionMetadata(cacheKey, fingerprint, hydratedCached);
      }
      sessions.push(hydratedCached);
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
      fileSizeBytes: fileStat.size,
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

  const [claude, codexResult, copilot] = await Promise.all([
    collectClaudeSessions(),
    collectCodexSessions(),
    collectCopilotSessions(),
  ]);

  const sessions = [
    ...claude.map(decorateClaudeSessionConfig),
    ...codexResult.sessions,
    ...copilot,
  ].map(applySessionTitleOverride);

  return {
    sessions,
    hiddenCodexSubagentSessions: codexResult.hiddenSubagentSessions || [],
  };
}

async function buildSessionsSnapshot() {
  const collected = await collectAllSessions();
  const sessions = collected.sessions;
  const projects = buildProjectRows(sessions);
  const sessionsByProject = new Map();
  const sessionsDigestByProject = new Map();
  const hiddenCodexSubagentsByParent = new Map();

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

  for (const subagentSession of collected.hiddenCodexSubagentSessions || []) {
    if (!subagentSession.parentThreadId) continue;
    const key = buildCodexSubagentParentKey(
      subagentSession.projectPath,
      subagentSession.parentThreadId,
    );
    const existing = hiddenCodexSubagentsByParent.get(key) || [];
    existing.push(subagentSession);
    hiddenCodexSubagentsByParent.set(key, existing);
  }

  for (const sessionsForParent of hiddenCodexSubagentsByParent.values()) {
    sessionsForParent.sort((left, right) => {
      const leftTime = new Date(left.created || left.modified || 0).getTime();
      const rightTime = new Date(right.created || right.modified || 0).getTime();
      return leftTime - rightTime;
    });
  }

  const snapshot = {
    builtAt: Date.now(),
    sessions,
    projects,
    projectsDigest: buildProjectDigest(projects),
    sessionsByProject,
    sessionsDigestByProject,
    hiddenCodexSubagentsByParent,
  };

  sessionsSnapshotCache = snapshot;
  await persistSessionMetadataCache();
  return snapshot;
}

function startSessionsSnapshotRefresh() {
  if (sessionsSnapshotRefreshPromise) {
    return sessionsSnapshotRefreshPromise;
  }

  sessionsSnapshotRefreshPromise = buildSessionsSnapshot()
    .finally(() => {
      sessionsSnapshotRefreshPromise = null;
    });

  return sessionsSnapshotRefreshPromise;
}

function refreshSessionsSnapshotInBackground() {
  startSessionsSnapshotRefresh().catch((err) => {
    console.error('[session-dashboard] background snapshot refresh failed', err);
  });
}

async function getSessionsSnapshot(force = false) {
  if (force) {
    return startSessionsSnapshotRefresh();
  }

  if (sessionsSnapshotCache) {
    if (Date.now() - sessionsSnapshotCache.builtAt < SESSION_SNAPSHOT_TTL_MS) {
      return sessionsSnapshotCache;
    }
    refreshSessionsSnapshotInBackground();
    return sessionsSnapshotCache;
  }

  return startSessionsSnapshotRefresh();
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
        archivedSessionCount: 0,
        totalSessionCount: 0,
        sourceCounts: {},
        sources: [],
        latestModified: 0,
        latestVisibleModified: 0,
      });
    }

    const row = projectMap.get(projectPath);
    row.totalSessionCount++;
    if (session.archived) {
      row.archivedSessionCount++;
    } else {
      row.sessionCount++;
    }
    row.sourceCounts[session.source] = (row.sourceCounts[session.source] || 0) + 1;
    row.sources = Object.keys(row.sourceCounts).sort();
    const modifiedTime = session.modified ? new Date(session.modified).getTime() : 0;
    row.latestModified = Math.max(row.latestModified, modifiedTime);
    if (!session.archived) {
      row.latestVisibleModified = Math.max(row.latestVisibleModified, modifiedTime);
    }
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
  if (typeof content === 'string') {
    return hasNonEmptyText(content) ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const normalized = normalizeText(content);
    return hasNonEmptyText(normalized) ? [{ type: 'text', text: normalized }] : [];
  }

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return null;

      if (block.type === 'text') {
        return hasNonEmptyText(block.text) ? { type: 'text', text: block.text || '' } : null;
      }
      if (block.type === 'thinking') {
        const thinkingText = typeof block.thinking === 'string'
          ? block.thinking
          : normalizeText(block.thinking ?? block.text ?? block.content ?? '');
        return hasNonEmptyText(thinkingText)
          ? { type: 'thinking', text: thinkingText, signature: block.signature || '' }
          : null;
      }
      if (block.type === 'redacted_thinking') {
        const reason = typeof block.reason === 'string'
          ? block.reason
          : normalizeText(block.reason ?? block.data ?? '');
        return {
          type: 'redacted_thinking',
          text: hasNonEmptyText(reason)
            ? reason
            : 'Reasoning content was redacted by the source session.',
        };
      }
      if (block.type === 'tool_use') {
        const normalizedInput = normalizeToolPayload(block.input);
        return {
          type: 'tool_use',
          name: block.name || 'unknown',
          tool_use_id: block.id || '',
          summary: summarizeToolPayload(block.name || 'unknown', normalizedInput),
          input: compactStructuredValue(normalizedInput),
        };
      }
      if (block.type === 'tool_result') {
        return buildClaudeToolResultBlock(block);
      }

      const fallback = truncateText(JSON.stringify(block), 500);
      return hasNonEmptyText(fallback) ? { type: 'text', text: fallback } : null;
    })
    .filter(Boolean);
}

function buildClaudeToolResultBlock(block, toolUseResult = null) {
  const resultText = Array.isArray(block?.content)
    ? block.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text || '')
        .join('\n')
    : normalizeText(block?.content);
  const normalizedStructured = toolUseResult && typeof toolUseResult === 'object'
    ? compactStructuredValue(toolUseResult)
    : null;
  const stringStructured = typeof toolUseResult === 'string' ? normalizeText(toolUseResult) : '';
  const summary = block?.is_error
    ? truncateText(resultText || stringStructured || 'Tool error', 180)
    : summarizeStructuredToolResult(toolUseResult)
      || truncateText((resultText || stringStructured || 'Tool completed').split('\n')[0], 180);

  return {
    type: 'tool_result',
    tool_use_id: block?.tool_use_id || '',
    content: truncateText(resultText || stringStructured, 2500),
    summary,
    isError: !!block?.is_error || /^error:/i.test(stringStructured),
    structured: normalizedStructured,
  };
}

function parseClaudeToolResults(content, toolUseResult = null) {
  if (!content) return [];
  if (!Array.isArray(content)) {
    if (toolUseResult && typeof toolUseResult === 'object') {
      return [
        {
          type: 'tool_result',
          tool_use_id: '',
          content: truncateText(normalizeText(content), 2500),
          summary: summarizeStructuredToolResult(toolUseResult),
          structured: compactStructuredValue(toolUseResult),
          isError: false,
        },
      ];
    }
    return [{ type: 'text', text: truncateText(normalizeText(content), 1500) }];
  }

  return content.map((block) => {
    if (block.type === 'tool_result') {
      return buildClaudeToolResultBlock(block, toolUseResult);
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
        const assistantContent = parseClaudeAssistantContent(content);
        if (assistantContent.length === 0) {
          return;
        }
        messages.push({
          ...base,
          model: obj.message?.model || '',
          content: assistantContent,
        });
        return;
      }

      if (effectiveType === 'tool_result') {
        messages.push({
          ...base,
          content: parseClaudeToolResults(content, obj.toolUseResult || null),
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
  const normalizedInput = normalizeToolPayload(input);
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
        tool_use_id: uuid || '',
        summary: summarizeToolPayload(toolName || 'tool', normalizedInput),
        input: compactStructuredValue(normalizedInput),
      },
    ],
  };
}

function makeToolResultMessage(source, timestamp, uuid, content, extra = {}) {
  const normalizedContent = normalizeToolPayload(content);
  const compactContent = typeof normalizedContent === 'string'
    ? truncateText(normalizedContent, 5000)
    : compactStructuredValue(normalizedContent);
  const summary = extra.summary
    || summarizeStructuredToolResult(normalizedContent)
    || truncateText(normalizeText(compactContent).split('\n')[0], 180);
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
        content: compactContent,
        summary,
        isError: !!extra.isError,
        structured: normalizedContent && typeof normalizedContent === 'object'
          ? compactStructuredValue(normalizedContent)
          : null,
      },
    ],
  };
}

function parseCodexToolResultOutput(payload) {
  if (payload.type === 'function_call_output') {
    return normalizeToolPayload(payload.output);
  }

  if (payload.type === 'custom_tool_call_output') {
    const parsed = safeJsonParse(payload.output);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.output === 'string') return normalizeToolPayload(parsed.output);
      return parsed;
    }
    return normalizeToolPayload(payload.output);
  }

  return normalizeToolPayload(payload.output);
}

function ensureCodexToolState(state) {
  if (!state.pendingToolCalls) state.pendingToolCalls = new Map();
  if (!state.completedToolCalls) state.completedToolCalls = new Set();
}

function queuePendingCodexToolCall(state, descriptor) {
  ensureCodexToolState(state);
  if (!descriptor?.callId) return;
  state.pendingToolCalls.set(descriptor.callId, descriptor);
}

function getPendingCodexToolCall(state, callId) {
  ensureCodexToolState(state);
  return callId ? (state.pendingToolCalls.get(callId) || null) : null;
}

function takePendingCodexToolCall(state, callId) {
  ensureCodexToolState(state);
  const pending = state.pendingToolCalls.get(callId) || null;
  if (callId) {
    state.pendingToolCalls.delete(callId);
    state.completedToolCalls.add(callId);
  }
  return pending;
}

function hasCompletedCodexToolCall(state, callId) {
  ensureCodexToolState(state);
  return !!callId && state.completedToolCalls.has(callId);
}

function shouldDelayCodexToolOutput(toolName) {
  return toolName === 'exec_command' || toolName === 'apply_patch';
}

function storePendingCodexToolOutput(state, callId, output, timestamp) {
  const pending = getPendingCodexToolCall(state, callId);
  if (!pending) return null;
  pending.fallbackOutput = output;
  pending.fallbackTimestamp = timestamp || pending.fallbackTimestamp || pending.timestamp || '';
  state.pendingToolCalls.set(callId, pending);
  return pending;
}

function extractCodexCommandText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length >= 3 && value[0] === '/bin/bash' && value[1] === '-lc') {
      return String(value[2] || '');
    }
    return value.map((item) => String(item)).join(' ');
  }
  if (typeof value === 'object') {
    if (typeof value.cmd === 'string') return value.cmd;
    if (typeof value.command === 'string') return value.command;
  }
  return '';
}

function normalizeCodexParsedCommands(parsedCommands) {
  if (!Array.isArray(parsedCommands)) return [];
  return parsedCommands.map((entry) => ({
    type: entry?.type || 'unknown',
    cmd: typeof entry?.cmd === 'string' ? entry.cmd : '',
    name: typeof entry?.name === 'string' ? entry.name : '',
    path: typeof entry?.path === 'string' ? entry.path : '',
    query: typeof entry?.query === 'string' ? entry.query : '',
  }));
}

function buildPatchApplyDiffSource(changes) {
  if (!changes || typeof changes !== 'object') return '';
  const parts = [];
  for (const [pathName, change] of Object.entries(changes)) {
    if (!change || typeof change !== 'object') continue;
    const diff = typeof change.unified_diff === 'string' ? change.unified_diff.trim() : '';
    if (!diff) continue;
    const nextPath = typeof change.move_path === 'string' && change.move_path
      ? change.move_path
      : pathName;
    parts.push(`--- ${pathName}`);
    parts.push(`+++ ${nextPath}`);
    parts.push(diff);
  }
  return parts.join('\n');
}

function buildPatchApplyChanges(changes) {
  if (!changes || typeof changes !== 'object') return [];
  return Object.entries(changes).map(([pathName, change]) => ({
    path: pathName,
    kind: change?.type || '',
    movePath: change?.move_path || '',
    unifiedDiff: typeof change?.unified_diff === 'string' ? change.unified_diff : '',
  }));
}

function makeCodexToolActivityMessage(timestamp, callId, data, state) {
  return {
    type: 'tool_activity',
    source: 'codex',
    sourceLabel: SOURCE_META.codex.label,
    timestamp: timestamp || '',
    uuid: callId || '',
    callId: callId || '',
    toolName: data.toolName || 'tool',
    input: data.input ?? null,
    command: data.command || '',
    parsedCommands: normalizeCodexParsedCommands(data.parsedCommands),
    output: typeof data.output === 'string' ? truncateText(data.output, 12000) : normalizeText(data.output),
    exitCode: Number.isInteger(data.exitCode) ? data.exitCode : null,
    isError: !!data.isError,
    changes: Array.isArray(data.changes) ? data.changes : [],
    diffSource: typeof data.diffSource === 'string' ? data.diffSource : '',
    summary: data.summary || '',
    _mergeOrder: nextMessageOrder(state),
  };
}

function flushPendingCodexToolCalls(messages, state) {
  ensureCodexToolState(state);
  for (const pending of state.pendingToolCalls.values()) {
    const output = pending.fallbackOutput ?? '';
    messages.push(
      makeCodexToolActivityMessage(
        pending.fallbackTimestamp || pending.timestamp,
        pending.callId,
        {
          toolName: pending.toolName,
          input: pending.input,
          command: pending.command,
          diffSource: pending.toolName === 'apply_patch' && typeof pending.input === 'string'
            ? pending.input
            : '',
          output,
          summary: summarizeStructuredToolResult(output)
            || summarizeToolPayload(pending.toolName || 'tool', pending.input),
        },
        state,
      ),
    );
  }
  state.pendingToolCalls.clear();
}

function codexMessageTimestampMs(message) {
  if (!message?.timestamp) return Number.NaN;
  const value = new Date(message.timestamp).getTime();
  return Number.isFinite(value) ? value : Number.NaN;
}

function codexMessagesWithinWindow(left, right, windowMs) {
  const leftMs = codexMessageTimestampMs(left);
  const rightMs = codexMessageTimestampMs(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return false;
  return Math.abs(rightMs - leftMs) <= windowMs;
}

function extractCodexMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') {
    return normalizeText(message.content).trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (typeof block?.text === 'string') return block.text;
        if (typeof block?.summary === 'string') return block.summary;
        if (typeof block?.content === 'string') return block.content;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof message.summary === 'string') return message.summary.trim();
  if (typeof message.command === 'string') return message.command.trim();
  return '';
}

function codexAssistantDuplicateScore(message) {
  let score = 0;
  if (message?.roleLabel === 'CODEX') score += 4;
  if (message?.roleLabel && message.roleLabel !== 'COMMENTARY') score += 1;
  if (message?.model) score += 1;
  score += extractCodexMessageText(message).length;
  return score;
}

function codexToolActivityScore(message) {
  let score = 0;
  if (message?.input != null) score += 2;
  if (Array.isArray(message?.parsedCommands) && message.parsedCommands.length) score += 2;
  if (Number.isInteger(message?.exitCode)) score += 3;
  if (Array.isArray(message?.changes) && message.changes.length) score += 2;
  if (message?.isError) score += 1;
  score += extractCodexMessageText(message).length;
  return score;
}

function isDuplicateCodexAssistantMessage(previous, current) {
  if (previous?.type !== 'assistant' || current?.type !== 'assistant') return false;
  const previousText = extractCodexMessageText(previous);
  const currentText = extractCodexMessageText(current);
  if (!previousText || previousText !== currentText) return false;
  return codexMessagesWithinWindow(previous, current, 3000);
}

function isDuplicateCodexStatusMessage(previous, current) {
  if (previous?.type !== 'status' || current?.type !== 'status') return false;
  const previousText = extractCodexMessageText(previous);
  const currentText = extractCodexMessageText(current);
  if (!previousText || previousText !== currentText) return false;
  return codexMessagesWithinWindow(previous, current, 5000);
}

function findRecentCodexStatusDuplicateIndex(messages, current) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.type === 'status' && isDuplicateCodexStatusMessage(candidate, current)) {
      return index;
    }
    if (candidate?.type === 'tool_activity') {
      continue;
    }
    break;
  }
  return -1;
}

function isDuplicateCodexToolActivity(previous, current) {
  if (previous?.type !== 'tool_activity' || current?.type !== 'tool_activity') return false;
  if (!previous.callId || !current.callId || previous.callId !== current.callId) return false;
  return codexMessagesWithinWindow(previous, current, 5000);
}

function dedupeCodexMessages(messages) {
  const deduped = [];

  for (const message of messages || []) {
    const previous = deduped[deduped.length - 1];
    if (!previous) {
      deduped.push(message);
      continue;
    }

    if (isDuplicateCodexAssistantMessage(previous, message)) {
      if (codexAssistantDuplicateScore(message) > codexAssistantDuplicateScore(previous)) {
        deduped[deduped.length - 1] = message;
      }
      continue;
    }

    const duplicateStatusIndex = message?.type === 'status'
      ? findRecentCodexStatusDuplicateIndex(deduped, message)
      : -1;
    if (duplicateStatusIndex !== -1) {
      continue;
    }

    if (isDuplicateCodexToolActivity(previous, message)) {
      if (codexToolActivityScore(message) >= codexToolActivityScore(previous)) {
        deduped[deduped.length - 1] = message;
      }
      continue;
    }

    deduped.push(message);
  }

  return deduped;
}


function appendCodexMessageFromObject(obj, messages, state = {}) {
  if (!obj || typeof obj !== 'object') return;

  if (obj.type === 'turn_context') {
    state.currentModel = obj.payload?.model || state.currentModel || state.fallbackModel || '';
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
      _mergeOrder: nextMessageOrder(state),
    });
    return;
  }

  if (obj.type === 'event_msg' && obj.payload?.type === 'agent_message') {
    if (obj.payload?.phase === 'final_answer') return;
    const text = normalizeText(obj.payload?.message);
    if (!text) return;
    messages.push({
      type: 'assistant',
      source: 'codex',
      sourceLabel: SOURCE_META.codex.label,
      timestamp: obj.timestamp || '',
      uuid: '',
      roleLabel: obj.payload?.phase === 'commentary' ? 'COMMENTARY' : 'CODEX',
      content: [{ type: 'text', text }],
      _mergeOrder: nextMessageOrder(state),
    });
    return;
  }

  if (obj.type === 'event_msg' && obj.payload?.type === 'task_started') {
    const contextWindow = Number(obj.payload?.model_context_window ?? 0);
    messages.push({
      type: 'status',
      source: 'codex',
      sourceLabel: SOURCE_META.codex.label,
      timestamp: obj.timestamp || '',
      uuid: '',
      content: contextWindow > 0
        ? `Task started. Context window ${contextWindow.toLocaleString()} tokens.`
        : 'Task started.',
      _mergeOrder: nextMessageOrder(state),
    });
    return;
  }

  if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete') {
    const durationMs = Number(obj.payload?.duration_ms ?? 0);
    messages.push({
      type: 'status',
      source: 'codex',
      sourceLabel: SOURCE_META.codex.label,
      timestamp: normalizeEpochTimestamp(obj.payload?.completed_at) || obj.timestamp || '',
      uuid: '',
      content: durationMs > 0
        ? `Task completed in ${(durationMs / 1000).toFixed(1)}s.`
        : 'Task completed.',
      _mergeOrder: nextMessageOrder(state),
    });
    return;
  }

  if (obj.type === 'event_msg' && obj.payload?.type === 'turn_aborted') {
    messages.push({
      type: 'status',
      source: 'codex',
      sourceLabel: SOURCE_META.codex.label,
      timestamp: obj.timestamp || '',
      uuid: '',
      content: truncateText(normalizeText(obj.payload?.reason || 'Turn aborted.'), 240),
      _mergeOrder: nextMessageOrder(state),
    });
    return;
  }

  if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
    const summary = buildCodexTokenUsageSummary(obj.payload?.info || null);
    if (!summary) return;
    messages.push({
      type: 'status',
      source: 'codex',
      sourceLabel: SOURCE_META.codex.label,
      timestamp: obj.timestamp || '',
      uuid: '',
      content: summary,
      _mergeOrder: nextMessageOrder(state),
    });
    return;
  }

  if (obj.type === 'event_msg' && obj.payload?.type === 'exec_command_end') {
    const callId = obj.payload?.call_id || '';
    const pending = takePendingCodexToolCall(state, callId);
    const fallbackOutput = pending?.fallbackOutput ?? '';
    const command = extractCodexCommandText(obj.payload?.command) || pending?.command || '';
    messages.push(
      makeCodexToolActivityMessage(
        obj.timestamp || '',
        callId,
        {
          toolName: pending?.toolName || 'exec_command',
          input: pending?.input ?? null,
          command,
          parsedCommands: obj.payload?.parsed_cmd || [],
          output: obj.payload?.aggregated_output || fallbackOutput,
          exitCode: Number.isInteger(obj.payload?.exit_code) ? obj.payload.exit_code : null,
          isError: obj.payload?.status === 'failed' || Number(obj.payload?.exit_code || 0) !== 0,
          summary: command || summarizeToolPayload('exec_command', pending?.input ?? command),
        },
        state,
      ),
    );
    return;
  }

  if (obj.type === 'event_msg' && obj.payload?.type === 'patch_apply_end') {
    const callId = obj.payload?.call_id || '';
    const pending = takePendingCodexToolCall(state, callId);
    const fallbackOutput = pending?.fallbackOutput ?? '';
    const diffSource = (pending && typeof pending.input === 'string' ? pending.input : '')
      || buildPatchApplyDiffSource(obj.payload?.changes);
    messages.push(
      makeCodexToolActivityMessage(
        obj.timestamp || '',
        callId,
        {
          toolName: pending?.toolName || 'apply_patch',
          input: pending?.input ?? null,
          diffSource,
          output: [obj.payload?.stdout || '', obj.payload?.stderr || ''].filter(Boolean).join('\n') || fallbackOutput,
          changes: buildPatchApplyChanges(obj.payload?.changes),
          isError: obj.payload?.success === false,
          summary: summarizeToolPayload('apply_patch', diffSource || pending?.input || ''),
        },
        state,
      ),
    );
    return;
  }

  if (obj.type !== 'response_item') return;

  const payload = obj.payload || {};
  const timestamp = obj.timestamp || '';
  const assistantModel = state.currentModel || state.fallbackModel || '';

  if (payload.type === 'message' && payload.role === 'assistant') {
    messages.push({
      type: 'assistant',
      source: 'codex',
      sourceLabel: SOURCE_META.codex.label,
      timestamp,
      uuid: '',
      model: assistantModel,
      roleLabel: 'CODEX',
      content: parseCodexAssistantBlocks(payload.content),
      _mergeOrder: nextMessageOrder(state),
    });
    return;
  }

  if (payload.type === 'function_call') {
    const normalizedInput = normalizeToolPayload(payload.arguments);
    queuePendingCodexToolCall(state, {
      callId: payload.call_id || '',
      timestamp,
      toolName: payload.name || 'tool',
      input: normalizedInput,
      command: extractCodexCommandText(normalizedInput),
    });
    return;
  }

  if (payload.type === 'custom_tool_call') {
    queuePendingCodexToolCall(state, {
      callId: payload.call_id || '',
      timestamp,
      toolName: payload.name || 'tool',
      input: payload.input,
      command: extractCodexCommandText(payload.input),
    });
    return;
  }

  if (payload.type === 'web_search_call') {
    const searchInput =
      payload.action?.query ||
      payload.action?.queries ||
      payload.action ||
      '';
    queuePendingCodexToolCall(state, {
      callId: payload.call_id || '',
      timestamp,
      toolName: 'web_search',
      input: searchInput,
      command: '',
    });
    return;
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const callId = payload.call_id || '';
    if (hasCompletedCodexToolCall(state, callId)) {
      return;
    }
    const pending = getPendingCodexToolCall(state, callId);
    const parsedOutput = parseCodexToolResultOutput(payload);
    if (pending) {
      if (shouldDelayCodexToolOutput(pending.toolName)) {
        storePendingCodexToolOutput(state, callId, parsedOutput, timestamp);
        return;
      }
      takePendingCodexToolCall(state, callId);
      messages.push(
        makeCodexToolActivityMessage(
          timestamp,
          callId,
          {
            toolName: pending.toolName,
            input: pending.input,
            command: pending.command,
            output: parsedOutput,
            diffSource: pending.toolName === 'apply_patch' && typeof pending.input === 'string'
              ? pending.input
              : '',
            summary: summarizeStructuredToolResult(parsedOutput)
              || summarizeToolPayload(pending.toolName || 'tool', pending.input),
          },
          state,
        ),
      );
      return;
    }
    messages.push(
      makeToolResultMessage(
        'codex',
        timestamp,
        payload.call_id || '',
        parsedOutput
      )
    );
  }
}

async function readTailLines(filePath, lineCount) {
  const { stdout } = await execFileAsync(
    'tail',
    ['-n', String(lineCount), filePath],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  return stdout || '';
}

async function loadRecentCodexMessages(filePath, limit) {
  let lineCount = Math.max(RECENT_TAIL_LINES_INITIAL, limit * 40);

  while (lineCount <= RECENT_TAIL_LINES_MAX) {
    let tailOutput = '';
    try {
      tailOutput = await readTailLines(filePath, lineCount);
    } catch {
      return null;
    }

    if (!tailOutput) {
      return { messages: [], total: 0, hasMore: false };
    }

    const rawLines = tailOutput.split(/\r?\n/).filter(Boolean);
    const messages = [];
    const state = { currentModel: '', fallbackModel: '' };

    for (const rawLine of rawLines) {
      const obj = safeJsonParse(rawLine);
      if (!obj) continue;
      appendCodexMessageFromObject(obj, messages, state);
    }

    flushPendingCodexToolCalls(messages, state);
    const dedupedMessages = dedupeCodexMessages(messages);

    if (dedupedMessages.length >= limit || rawLines.length < lineCount || lineCount >= RECENT_TAIL_LINES_MAX) {
      const sliced = dedupedMessages.slice(-limit);
      const reachedStart = rawLines.length < lineCount;
      if (!reachedStart && lineCount >= RECENT_TAIL_LINES_MAX) {
        return null;
      }
      const total = reachedStart
        ? dedupedMessages.length
        : sliced.length + 1;
      return {
        messages: sliced,
        total,
        hasMore: reachedStart ? dedupedMessages.length > sliced.length : true,
      };
    }

    lineCount = Math.min(lineCount * 2, RECENT_TAIL_LINES_MAX);
  }

  return null;
}
async function parseCodexMessages(filePath) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    const messages = [];
    const state = { currentModel: '', fallbackModel: '' };

    rl.on('line', (line) => {
      const obj = safeJsonParse(line);
      if (!obj) return;
      appendCodexMessageFromObject(obj, messages, state);
    });

    rl.on('close', () => {
      flushPendingCodexToolCalls(messages, state);
      resolve(dedupeCodexMessages(messages));
    });
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

async function loadRecentMessagesForLocator(locator, limit = 50) {
  if (!locator || locator.source !== 'codex') return null;

  const storage = resolveSessionStorage(locator);
  const filePath = storage?.filePath;
  if (!filePath) return null;

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return null;
  }

  if (stat.size < LARGE_SESSION_FAST_PATH_BYTES) {
    return null;
  }

  const cacheKey = buildSessionMetadataCacheKey(`${locator.source}-recent:${limit}`, filePath);
  const fingerprint = buildFileFingerprint(stat);
  const cached = getRecentMessageCache(cacheKey, fingerprint);
  if (cached) {
    return cached;
  }

  const recent = await loadRecentCodexMessages(filePath, limit);
  if (recent) {
    setRecentMessageCache(cacheKey, fingerprint, recent);
  }
  return recent;
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

function getHiddenCodexSubagentSessionsForLocator(snapshot, locator) {
  if (!locator || locator.source !== 'codex' || !snapshot?.hiddenCodexSubagentsByParent) {
    return [];
  }

  const key = buildCodexSubagentParentKey(locator.projectPath, locator.rawSessionId);
  return snapshot.hiddenCodexSubagentsByParent.get(key) || [];
}

function buildCodexSubagentStatus(subagentSession, childMessages) {
  if (subagentSession?.completedAt) return 'completed';
  const reversedMessages = [...(childMessages || [])].reverse();
  const lastStatusText = reversedMessages
    .find((message) => message.type === 'status' && hasNonEmptyText(message.content))
    ?.content || '';
  if (typeof lastStatusText === 'string') {
    if (/aborted|interrupt/i.test(lastStatusText)) return 'aborted';
    if (/failed|error/i.test(lastStatusText)) return 'failed';
  }

  const modifiedMs = parseTimestampMs(subagentSession?.modified || '');
  const lastMessageMs = reversedMessages
    .map((message) => parseTimestampMs(message?.timestamp || ''))
    .find((value) => Number.isFinite(value));
  const newestMs = Number.isFinite(lastMessageMs)
    ? lastMessageMs
    : modifiedMs;
  if (Number.isFinite(newestMs) && (Date.now() - newestMs) > 30 * 60 * 1000) {
    return 'completed';
  }

  if ((childMessages || []).length > 0) {
    return 'active';
  }
  return 'started';
}

function summarizeCodexSubagentMessages(subagentSession, childMessages) {
  const lastAssistant = [...(childMessages || [])]
    .reverse()
    .find((message) => message.type === 'assistant' && Array.isArray(message.content));
  const assistantText = lastAssistant?.content
    ?.find((block) => block.type === 'text' && hasNonEmptyText(block.text))
    ?.text || '';
  if (assistantText) {
    return truncateText(assistantText.replace(/\s+/g, ' ').trim(), 220);
  }

  const lastStatus = [...(childMessages || [])]
    .reverse()
    .find((message) => message.type === 'status' && hasNonEmptyText(message.content));
  if (lastStatus?.content) {
    return truncateText(String(lastStatus.content), 220);
  }

  if (subagentSession?.firstPrompt) {
    return truncateText(subagentSession.firstPrompt, 220);
  }

  return '';
}

async function buildCodexSubagentGroupMessage(subagentSession, index, options = {}) {
  const childLocator = {
    source: 'codex',
    projectPath: subagentSession.projectPath,
    relativePath: subagentSession.relativePath,
    rawSessionId: subagentSession.rawSessionId,
  };
  const allMessages = await loadMessagesForLocator(childLocator);
  const tailLimit = Number(options.tailLimit || 0);
  const nestedMessages = tailLimit > 0 ? allMessages.slice(-tailLimit) : allMessages;
  const startedAt = subagentSession.created || allMessages[0]?.timestamp || '';
  const status = buildCodexSubagentStatus(subagentSession, allMessages);

  return {
    type: 'subagent_group',
    source: 'codex',
    sourceLabel: SOURCE_META.codex.label,
    timestamp: startedAt,
    uuid: `subagent:${subagentSession.rawSessionId}`,
    _mergeOrder: Number.isFinite(index) ? index + 1 : 1,
    subagent: {
      rawSessionId: subagentSession.rawSessionId || '',
      parentThreadId: subagentSession.parentThreadId || '',
      nickname: subagentSession.agentNickname || '',
      role: subagentSession.agentRole || '',
      depth: subagentSession.depth || 0,
      status,
      startedAt,
      completedAt: subagentSession.completedAt || '',
      durationMs: subagentSession.durationMs || 0,
    },
    messageCount: allMessages.length,
    totalMessages: allMessages.length,
    summary: summarizeCodexSubagentMessages(subagentSession, allMessages),
    hasMoreMessages: nestedMessages.length < allMessages.length,
    messages: nestedMessages,
  };
}

async function loadCodexSubagentGroupMessages(locator, snapshot, options = {}) {
  const subagentSessions = getHiddenCodexSubagentSessionsForLocator(snapshot, locator);
  if (!subagentSessions.length) return [];

  const groups = await Promise.all(
    subagentSessions.map((subagentSession, index) => buildCodexSubagentGroupMessage(
      subagentSession,
      index,
      options,
    )),
  );

  return groups.sort(compareTimestampedItems);
}

async function loadMergedMessagesForLocator(locator, snapshot, options = {}) {
  const baseMessages = await loadMessagesForLocator(locator);
  const subagentGroups = await loadCodexSubagentGroupMessages(locator, snapshot, options);
  if (!subagentGroups.length) {
    return baseMessages;
  }

  const merged = [
    ...baseMessages.map((message, index) => ({
      ...message,
      _mergeOrder: Number.isFinite(message?._mergeOrder) ? message._mergeOrder : (index + 1),
    })),
    ...subagentGroups.map((message, index) => ({
      ...message,
      _mergeOrder: baseMessages.length + index + 1,
    })),
  ];

  merged.sort(compareTimestampedItems);
  return merged;
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
      invalidateRecentMessageCache(buildSessionMetadataCacheKey(`${storage.source}-recent:50`, storage.filePath));
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
  const forceFresh = query.get('fresh') === '1';

  try {
    const snapshot = await getSessionsSnapshot(forceFresh);
    const hasHiddenSubagents = getHiddenCodexSubagentSessionsForLocator(snapshot, locator).length > 0;

    if (direction === 'newest' && offset === 0 && !hasHiddenSubagents) {
      const recent = await loadRecentMessagesForLocator(locator, limit);
      if (recent) {
        sendJSON(res, {
          messages: Array.isArray(recent.messages) ? recent.messages : [],
          total: Number.isFinite(recent.total) ? recent.total : (
            Array.isArray(recent.messages) ? recent.messages.length + (recent.hasMore ? 1 : 0) : 0
          ),
          hasMore: !!recent.hasMore,
        });
        return;
      }
    }

    const allMessages = hasHiddenSubagents
      ? await loadMergedMessagesForLocator(locator, snapshot)
      : await loadMessagesForLocator(locator);
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

async function handleGetSubagentGroups(req, res, projectToken, sessionToken, query) {
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

  const forceFresh = query.get('fresh') === '1';
  const tailLimit = parseInt(query.get('tail') || '0', 10);

  try {
    const snapshot = await getSessionsSnapshot(forceFresh);
    const groups = await loadCodexSubagentGroupMessages(locator, snapshot, {
      tailLimit: Number.isFinite(tailLimit) && tailLimit > 0 ? tailLimit : 0,
    });
    sendJSON(res, {
      groups,
      total: groups.length,
    });
  } catch (err) {
    sendError(res, 'Failed to read subagent groups: ' + err.message);
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
  const capabilities = await getInteractionCapabilities();
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
  const corsHeaders = pathname.startsWith('/api/') ? buildCorsHeaders(req) : null;

  if (corsHeaders) {
    for (const [key, value] of Object.entries(corsHeaders)) {
      res.setHeader(key, value);
    }
  }

  if (pathname.startsWith('/api/') && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0' });
    res.end();
    return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJSON(res, buildHealthPayload());
  }

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

  const subagentGroupsMatch = pathname.match(/^\/api\/subagent-groups\/([^/]+)\/([^/]+)$/);
  if (subagentGroupsMatch && req.method === 'GET') {
    return handleGetSubagentGroups(
      req,
      res,
      decodeURIComponent(subagentGroupsMatch[1]),
      decodeURIComponent(subagentGroupsMatch[2]),
      query,
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

server.on('error', (err) => {
  console.error('[session-dashboard] server error', err);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[session-dashboard] received ${signal}, shutting down`);
  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[session-dashboard] forced shutdown after timeout');
    process.exit(1);
  }, 5000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[session-dashboard] uncaught exception', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[session-dashboard] unhandled rejection', reason);
  process.exit(1);
});

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
