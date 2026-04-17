import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os, { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from './config.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 6;
const _cfg = loadRuntimeConfig();
const WORKSPACE_ROOT = _cfg.workspaceRoot || os.homedir();
const COPILOT_BINARY = _cfg.copilotBin || 'copilot';
const COPILOT_CONFIG_DIR = _cfg.copilotConfigDir;
const COPILOT_CONFIG_FILE = _cfg.copilotConfigFile;
const VSCODE_EXTENSIONS_DIR = _cfg.vscodeExtensionsDir;
const VSCODE_CODEX_EXTENSION_PREFIX = 'openai.chatgpt-';
const DEFAULT_CODEX_BINARY = _cfg.codexBin || 'codex';
const DEFAULT_CODEX_ORIGINATOR = 'codex_vscode';
const CODEX_REQUEST_TIMEOUT_MS = 60000;
const CODEX_THREAD_RESUME_TIMEOUT_MS = 150000;
const CODEX_THREAD_RESUME_MAX_ATTEMPTS = 2;
const CODEX_THREAD_RESUME_RETRY_DELAY_MS = 800;
const CODEX_THREAD_RESUME_STATUS_INTERVAL_MS = 15000;
const CODEX_WARM_IDLE_TTL_MS = 10 * 60 * 1000;
const CODEX_WARM_SELF_REFRESH_GRACE_MS = 10000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_MODELS_FILE = _cfg.claudeModelsFile;
const CLAUDE_PROVENANCE_FILE = path.join(__dirname, 'data', 'claude-session-provenance.json');
let resolvedCodexBinaryPromise = null;
let sharedCodexWarmWorker = null;

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
}

function truncateText(text, limit = 1200) {
  const str = typeof text === 'string' ? text : JSON.stringify(text || '');
  if (str.length <= limit) return str;
  return str.slice(0, limit) + '...';
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codexBinaryName() {
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function codexBinarySubdir() {
  let platformPart = null;
  if (process.platform === 'darwin') platformPart = 'macos';
  if (process.platform === 'linux') platformPart = 'linux';
  if (process.platform === 'win32') platformPart = 'windows';

  let archPart = null;
  if (process.arch === 'x64') archPart = 'x86_64';
  if (process.arch === 'arm64') archPart = 'aarch64';

  if (!platformPart || !archPart) return '';
  return `${platformPart}-${archPart}`;
}

async function resolveCodexBinary() {
  if (resolvedCodexBinaryPromise) {
    return resolvedCodexBinaryPromise;
  }

  resolvedCodexBinaryPromise = (async () => {
    const manualOverride = process.env.SESSION_DASHBOARD_CODEX_BINARY?.trim();
    if (manualOverride) {
      return manualOverride;
    }

    const binSubdir = codexBinarySubdir();
    if (!binSubdir) {
      return DEFAULT_CODEX_BINARY;
    }

    try {
      const entries = await fsp.readdir(VSCODE_EXTENSIONS_DIR, { withFileTypes: true });
      const extensionDirs = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(VSCODE_CODEX_EXTENSION_PREFIX))
        .map((entry) => entry.name)
        .sort()
        .reverse();

      for (const dirName of extensionDirs) {
        const candidate = path.join(
          VSCODE_EXTENSIONS_DIR,
          dirName,
          'bin',
          binSubdir,
          codexBinaryName(),
        );
        if (await pathExists(candidate)) {
          return candidate;
        }
      }
    } catch {
      // Fall back to whatever `codex` resolves to on PATH.
    }

    return DEFAULT_CODEX_BINARY;
  })();

  return resolvedCodexBinaryPromise;
}

function extractCopilotModel(message) {
  if (typeof message !== 'string') return '';
  const match = message.match(/Model changed to:\s*(.+)$/);
  return match ? match[1].trim() : message.trim();
}

async function getCopilotToken() {
  try {
    const raw = await fsp.readFile(COPILOT_CONFIG_FILE, 'utf-8');
    const config = JSON.parse(raw);
    const token = Object.values(config.copilot_tokens || {})[0];
    return typeof token === 'string' && token ? token : '';
  } catch {
    return '';
  }
}

export async function getInteractionCapabilities() {
  const copilotToken = await getCopilotToken();
  const copilotReady = !!copilotToken;

  return {
    codex: {
      enabled: true,
      directImages: true,
      streamMode: 'message',
      note: 'Text is sent into the selected Codex session and continues that session context. Images are attached natively via the Codex CLI.',
    },
    claude: {
      enabled: true,
      directImages: false,
      streamMode: 'delta',
      note: 'Text is sent into the selected Claude session and continues that session context. Images are saved on the server and referenced by local file path for tool inspection.',
    },
    copilot: {
      enabled: copilotReady,
      directImages: false,
      streamMode: 'delta',
      note: copilotReady
        ? 'Text is sent into the selected Copilot session and continues that session context. Images are saved on the server and referenced by local file path.'
        : 'Copilot CLI interaction is unavailable until a GitHub token is present in the local Copilot config.',
    },
  };
}

function beginNdjson(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Connection: 'keep-alive',
  });
}

function sendEvent(res, payload) {
  res.write(JSON.stringify(payload) + '\n');
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function sanitizeFilename(name, fallback = 'image') {
  const base = (name || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || fallback;
}

function extensionFromMime(type) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
  };
  return map[type] || '';
}

function safeJsonObject(text) {
  const parsed = safeJsonParse(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function buildSessionKey(locator) {
  if (!locator?.source || !locator?.projectPath || !locator?.rawSessionId) return '';
  return JSON.stringify({
    source: locator.source,
    projectPath: locator.projectPath,
    rawSessionId: locator.rawSessionId,
  });
}

async function loadClaudeProfiles() {
  try {
    const raw = await fsp.readFile(CLAUDE_MODELS_FILE, 'utf-8');
    const parsed = safeJsonObject(raw);
    return parsed.models && typeof parsed.models === 'object' ? parsed.models : {};
  } catch {
    return {};
  }
}

async function loadClaudeProvenance() {
  try {
    const raw = await fsp.readFile(CLAUDE_PROVENANCE_FILE, 'utf-8');
    return safeJsonObject(raw);
  } catch {
    return {};
  }
}

async function persistClaudeProvenance(provenance) {
  await fsp.mkdir(path.dirname(CLAUDE_PROVENANCE_FILE), { recursive: true });
  await fsp.writeFile(CLAUDE_PROVENANCE_FILE, JSON.stringify(provenance, null, 2) + '\n', 'utf-8');
}

async function resolveClaudeLaunchContext(locator, sessionMeta = null, profileOverride = '') {
  const models = await loadClaudeProfiles();
  const provenance = await loadClaudeProvenance();
  const key = buildSessionKey(locator);
  const saved = key ? provenance[key] || null : null;

  if (profileOverride && models[profileOverride]?.env) {
    const env = models[profileOverride].env || {};
    return {
      profile: profileOverride,
      profileLabel: profileOverride.toUpperCase(),
      anthropicModel: env.ANTHROPIC_MODEL || '',
      baseUrl: env.ANTHROPIC_BASE_URL || '',
      env,
      exact: true,
      source: 'manual-profile',
    };
  }

  if (saved?.profile && models[saved.profile]?.env) {
    const env = models[saved.profile].env || {};
    return {
      profile: saved.profile,
      profileLabel: saved.profileLabel || saved.profile.toUpperCase(),
      anthropicModel: env.ANTHROPIC_MODEL || saved.anthropicModel || '',
      baseUrl: env.ANTHROPIC_BASE_URL || saved.baseUrl || '',
      env,
      exact: true,
      source: 'recorded',
    };
  }

  const hintedProfile = sessionMeta?.claudeProfile || '';
  if (hintedProfile && models[hintedProfile]?.env) {
    const env = models[hintedProfile].env || {};
    return {
      profile: hintedProfile,
      profileLabel: sessionMeta?.claudeProfileLabel || hintedProfile.toUpperCase(),
      anthropicModel: env.ANTHROPIC_MODEL || sessionMeta?.claudeModel || '',
      baseUrl: env.ANTHROPIC_BASE_URL || sessionMeta?.claudeBaseUrl || '',
      env,
      exact: !!sessionMeta?.claudeProfileExact,
      source: sessionMeta?.claudeConfigSource || 'hinted',
    };
  }

  return {
    profile: '',
    profileLabel: '',
    anthropicModel: sessionMeta?.claudeModel || '',
    baseUrl: sessionMeta?.claudeBaseUrl || '',
    env: {},
    exact: false,
    source: 'default',
  };
}

async function recordClaudeProvenance(locator, launchContext) {
  const key = buildSessionKey(locator);
  if (!key || !launchContext) return;
  const provenance = await loadClaudeProvenance();
  provenance[key] = {
    profile: launchContext.profile || '',
    profileLabel: launchContext.profileLabel || '',
    anthropicModel: launchContext.anthropicModel || '',
    baseUrl: launchContext.baseUrl || '',
    source: launchContext.source || 'dashboard',
  };
  await persistClaudeProvenance(provenance);
}

async function materializeImages(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return { dir: '', files: [] };
  }

  const limited = images.slice(0, MAX_IMAGES);
  const uploadDir = path.join(tmpdir(), 'session-dashboard-uploads', randomUUID());
  await fsp.mkdir(uploadDir, { recursive: true });

  const files = [];
  for (let index = 0; index < limited.length; index++) {
    const image = limited[index] || {};
    const mimeType = typeof image.type === 'string' ? image.type : '';
    const dataUrl = typeof image.dataUrl === 'string' ? image.dataUrl : '';
    if (!mimeType.startsWith('image/') || !dataUrl.startsWith('data:')) {
      continue;
    }

    const match = dataUrl.match(/^data:(.*?);base64,(.+)$/);
    if (!match) continue;

    const ext = path.extname(image.name || '') || extensionFromMime(mimeType) || '.bin';
    const filename = `${String(index + 1).padStart(2, '0')}-${sanitizeFilename(
      path.basename(image.name || `image-${index + 1}`)
    ).replace(/\.[A-Za-z0-9]+$/, '')}${ext}`;
    const filePath = path.join(uploadDir, filename);
    await fsp.writeFile(filePath, Buffer.from(match[2], 'base64'));
    files.push({
      name: filename,
      path: filePath,
      mimeType,
    });
  }

  return { dir: uploadDir, files };
}

function imageCountText(count) {
  return `${count} image${count === 1 ? '' : 's'}`;
}

function buildPrompt(text, imageFiles, directImages) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  let prompt = trimmed;

  if (!prompt && imageFiles.length > 0) {
    prompt = 'Please inspect the attached image file(s) and help the user with them.';
  }

  if (!directImages && imageFiles.length > 0) {
    const fileList = imageFiles.map((file) => `- ${file.path}`).join('\n');
    const suffix = `\n\nThe user attached image file(s) saved locally on disk. Inspect them if helpful:\n${fileList}`;
    prompt = prompt ? `${prompt}${suffix}` : suffix.trim();
  }

  return prompt || 'Please continue the session.';
}

function processJsonLines(stream, onLine) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    const line = buffer.trim();
    if (line) onLine(line);
  });
}

function extractClaudeAssistantText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('');
}

function extractCopilotAssistantText(data) {
  if (typeof data?.content === 'string') return data.content;
  return '';
}

function createCodexArgs(locator, prompt, imageFiles) {
  const args = locator.draft
    ? ['exec', '--json', '--skip-git-repo-check', prompt]
    : ['exec', 'resume', locator.rawSessionId, prompt, '--json', '--skip-git-repo-check'];
  for (const image of imageFiles) {
    args.push('-i', image.path);
  }
  return args;
}

function createClaudeArgs(locator, prompt, uploadDir) {
  const args = locator.draft
    ? ['-p', '--verbose', '--output-format', 'stream-json', '--session-id', locator.rawSessionId, prompt]
    : ['-p', '--verbose', '--output-format', 'stream-json', '-r', locator.rawSessionId, prompt];
  if (uploadDir) {
    args.push('--add-dir', uploadDir);
  }
  return args;
}

function createCopilotArgs(locator, prompt, uploadDir) {
  const args = [
    '--config-dir',
    COPILOT_CONFIG_DIR,
    `--resume=${locator.rawSessionId}`,
    '-p',
    prompt,
    '--output-format',
    'json',
    '--stream',
    'on',
    '--allow-all-tools',
    '--allow-all-paths',
  ];
  if (uploadDir) {
    args.push('--add-dir', uploadDir);
  }
  return args;
}

function defaultCwd(locator) {
  return locator.projectPath && locator.projectPath !== '(unknown)' ? locator.projectPath : WORKSPACE_ROOT;
}

function formatCommandForDisplay(command) {
  if (typeof command !== 'string') return '';
  const bashMatch = command.match(/^\/bin\/bash -lc "(.*)"$/s);
  if (!bashMatch) return command;
  return bashMatch[1]
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function formatCommandResult(item) {
  const exitCode = Number.isInteger(item?.exit_code) ? item.exit_code : null;
  const output = typeof item?.aggregated_output === 'string' ? item.aggregated_output.trim() : '';
  const parts = [];
  if (exitCode != null) parts.push(`Result: Exit code ${exitCode}`);
  if (output) {
    parts.push('```text');
    parts.push(output);
    parts.push('```');
  }
  return parts.join('\n');
}

function formatFileChanges(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (!changes.length) return 'Updated files.';
  const lines = changes.map((change) => `- ${change.path}${change.kind ? ` (${change.kind})` : ''}`);
  return `Updated files:\n${lines.join('\n')}`;
}

function buildCodexCommandStartEvent(item) {
  const command = formatCommandForDisplay(item?.command || '');
  return {
    type: 'tool_event',
    toolName: 'shell_command',
    summary: truncateText(command.split('\n')[0] || 'shell_command', 180),
    command,
    content: command
      ? `shell_command\n\`\`\`bash\n${command}\n\`\`\``
      : 'shell_command',
  };
}

function buildCodexCommandResultEvent(item, formatter) {
  const command = formatCommandForDisplay(item?.command || '');
  const exitCode = Number.isInteger(item?.exitCode) ? item.exitCode : item?.exit_code;
  const aggregatedOutput = typeof item?.aggregatedOutput === 'string'
    ? item.aggregatedOutput
    : (typeof item?.aggregated_output === 'string' ? item.aggregated_output : '');
  return {
    type: 'tool_result',
    toolName: 'shell_command',
    summary: Number.isInteger(exitCode)
      ? `Exit code ${exitCode}`
      : truncateText((aggregatedOutput || command || 'shell_command').split('\n')[0], 180),
    command,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    aggregatedOutput,
    content: formatter(item),
  };
}

function buildCodexFileChangeEvent(item, formatter) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return {
    type: 'tool_event',
    toolName: 'apply_patch',
    summary: changes.length
      ? truncateText(changes.map((change) => change.path).join(', '), 180)
      : 'Updated files.',
    changes,
    content: `apply_patch\n${formatter(item)}`,
  };
}

function parseCodexLine(line, res) {
  const obj = safeJsonParse(line);
  if (!obj) {
    sendEvent(res, { type: 'status', message: truncateText(line, 400) });
    return;
  }

  if (obj.type === 'thread.started') {
    sendEvent(res, { type: 'meta', source: 'codex', sessionId: obj.thread_id });
    sendEvent(res, { type: 'session_created', source: 'codex', rawSessionId: obj.thread_id });
    return;
  }
  if (obj.type === 'turn.started') {
    sendEvent(res, { type: 'status', message: 'Codex resumed the selected session.' });
    return;
  }
  if (obj.type === 'item.started' && obj.item?.type === 'command_execution') {
    sendEvent(res, buildCodexCommandStartEvent(obj.item));
    return;
  }
  if (obj.type === 'item.completed' && obj.item?.type === 'command_execution') {
    sendEvent(res, buildCodexCommandResultEvent(obj.item, formatCommandResult));
    return;
  }
  if (obj.type === 'item.completed' && obj.item?.type === 'file_change') {
    sendEvent(res, buildCodexFileChangeEvent(obj.item, formatFileChanges));
    return;
  }
  if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
    sendEvent(res, {
      type: 'assistant_final',
      text: obj.item.text || '',
      itemId: obj.item.id || '',
      phase: obj.item.phase || '',
    });
    return;
  }
  if (obj.type === 'turn.completed') {
    sendEvent(res, { type: 'status', message: 'Codex turn completed.' });
  }
}

function extractCodexExtensionVersion(codexBinary) {
  if (typeof codexBinary !== 'string') return 'unknown';
  const match = codexBinary.match(/openai\.chatgpt-([^/]+)/);
  return match?.[1] || process.env.SESSION_DASHBOARD_CODEX_EXTENSION_VERSION || 'unknown';
}

function codexClientInfo(codexBinary) {
  return {
    name: 'VS Code',
    title: 'Codex Extension',
    version: extractCodexExtensionVersion(codexBinary),
  };
}

function resolveCodexThreadTarget(locator, sessionMeta = null) {
  const rawSessionId = (sessionMeta?.rawSessionId || locator?.rawSessionId || '').trim();
  if (rawSessionId) {
    return {
      mode: 'resume',
      rawSessionId,
    };
  }
  return {
    mode: 'start',
    rawSessionId: '',
  };
}

function buildCodexInputItems(text, imageFiles) {
  const items = [];
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const fallbackText = imageFiles.length > 0
    ? 'Please inspect the attached image file(s) and help the user with them.'
    : '';
  const contentText = trimmed || fallbackText;

  if (contentText) {
    items.push({
      type: 'text',
      text: contentText,
      text_elements: [],
    });
  }

  for (const image of imageFiles) {
    if (!image?.path) continue;
    items.push({
      type: 'localImage',
      path: image.path,
    });
  }

  return items;
}

function formatAppServerCommandResult(item) {
  const exitCode = Number.isInteger(item?.exitCode) ? item.exitCode : null;
  const output = typeof item?.aggregatedOutput === 'string' ? item.aggregatedOutput.trim() : '';
  const parts = [];
  if (exitCode != null) parts.push(`Result: Exit code ${exitCode}`);
  if (output) {
    parts.push('```text');
    parts.push(output);
    parts.push('```');
  }
  return parts.join('\n');
}

function formatAppServerFileChanges(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (!changes.length) return 'Updated files.';
  const lines = changes.map((change) => `- ${change.path}${change.kind ? ` (${change.kind})` : ''}`);
  return `Updated files:\n${lines.join('\n')}`;
}

function buildCodexTokenUsageMessage(tokenUsage) {
  const last = tokenUsage?.last;
  if (!last || !Number.isFinite(last.inputTokens)) return '';
  const cached = Number.isFinite(last.cachedInputTokens) ? last.cachedInputTokens : 0;
  const total = last.inputTokens;
  if (total <= 0) return '';
  const percent = Math.round((cached / total) * 100);
  return `Cache hit: ${cached}/${total} input tokens (${percent}%).`;
}

function buildCodexAppServerEnv(extraEnv = {}) {
  const env = { ...process.env, ...(extraEnv || {}) };
  delete env.TERM;
  delete env.COLORTERM;
  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  delete env.CODEX_CI;
  delete env.CODEX_THREAD_ID;
  return env;
}

function shouldIgnoreCodexAppServerLogLine(text) {
  if (!text) return false;

  return [
    /chatgpt authentication required to sync remote plugins; api key auth is not supported/i,
    /failed to warm featured plugin ids cache/i,
    /remote plugin sync request to https:\/\/chatgpt\.com\/backend-api\/plugins\/featured/i,
    /challenge-error-text/i,
    /Enable JavaScript and cookies to continue/i,
    /Failed to delete shell snapshot .*No such file or directory/i,
    /sqlx::query: slow statement: execution time exceeded alert threshold/i,
    /INSERT INTO logs \(ts,/i,
  ].some((pattern) => pattern.test(text));
}

function buildCodexWarmEnvSignature(env = {}) {
  return JSON.stringify(
    Object.entries(env || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)]),
  );
}

function buildCodexWarmReuseKey(options) {
  return JSON.stringify({
    command: options.command || '',
    cwd: options.cwd || '',
    rawSessionId: options.threadTarget?.rawSessionId || '',
    env: buildCodexWarmEnvSignature(options.env || {}),
  });
}

async function resolveCodexTranscriptFingerprint(options) {
  const relativePath = options.locator?.relativePath || '';
  const codexSessionsDir = options.config?.codexSessionsDir || '';
  if (!relativePath || !codexSessionsDir) return '';
  try {
    const stat = await fsp.stat(path.join(codexSessionsDir, relativePath));
    return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return '';
  }
}

function canUseWarmCodexWorker(options) {
  return Boolean(
    options.threadTarget?.mode === 'resume' &&
    options.threadTarget?.rawSessionId &&
    options.locator?.relativePath &&
    options.config?.codexSessionsDir,
  );
}

function clearSharedCodexWarmWorker(worker) {
  if (sharedCodexWarmWorker === worker) {
    sharedCodexWarmWorker = null;
  }
}

class CodexWarmWorker {
  constructor(options) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.env = options.env || {};
    this.reuseKey = options.reuseKey;
    this.locator = options.locator;
    this.config = options.config;
    this.currentThreadId = '';
    this.threadReady = false;
    this.initialized = false;
    this.closed = false;
    this.activeRequest = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
    this.stderr = '';
    this.idleTimer = null;
    this.forceKillTimer = null;
    this.fingerprintRefreshTimer = null;
    this.lastTurnCompletedAt = 0;
    this.transcriptFingerprint = options.transcriptFingerprint || '';
    this.needsFingerprintRefresh = false;
    this.child = spawn(this.command, ['app-server', '--analytics-default-enabled'], {
      cwd: this.cwd,
      env: buildCodexAppServerEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.attachProcessHandlers();
  }

  describeContext() {
    return `(cwd=${this.cwd}, thread=${this.currentThreadId || this.locator?.rawSessionId || ''})`;
  }

  attachProcessHandlers() {
    processJsonLines(this.child.stdout, (line) => {
      const message = safeJsonParse(line);
      if (!message) {
        this.sendStatusToActive(truncateText(line, 400));
        return;
      }

      if (
        Object.prototype.hasOwnProperty.call(message, 'id') &&
        (Object.prototype.hasOwnProperty.call(message, 'result') ||
          Object.prototype.hasOwnProperty.call(message, 'error'))
      ) {
        const id = String(message.id);
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        const elapsedMs = Date.now() - (pending.startedAt || Date.now());
        if (elapsedMs >= 5000) {
          console.warn(
            `[session-dashboard] Codex ${pending.method} completed in ${elapsedMs}ms ${this.describeContext()}`,
          );
        }
        if (message.error) {
          pending.reject(new Error(message.error.message || `${pending.method} failed.`));
          return;
        }
        pending.resolve(message.result);
        return;
      }

      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        this.handleServerRequest(message);
        return;
      }

      if (message.method) {
        this.handleNotification(message);
      }
    });

    this.child.stderr.on('data', (chunk) => {
      const lines = chunk
        .toString('utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !shouldIgnoreCodexAppServerLogLine(line));

      if (!lines.length) return;

      const text = lines.join('\n');
      this.stderr += (this.stderr ? '\n' : '') + text;
      for (const line of lines) {
        this.sendStatusToActive(truncateText(line, 400));
      }
    });

    this.child.on('error', (err) => {
      this.handleChildShutdown(err.message || 'Failed to start Codex app-server.');
    });

    this.child.on('close', (code) => {
      if (this.forceKillTimer) {
        clearTimeout(this.forceKillTimer);
        this.forceKillTimer = null;
      }
      const active = this.activeRequest;
      const graceful = !!active?.turnCompleted || code === 0;
      const message = graceful
        ? ''
        : (this.stderr.trim() || `Codex app-server exited with code ${code}`);
      this.closed = true;
      clearSharedCodexWarmWorker(this);
      for (const { reject, timer } of this.pendingRequests.values()) {
        clearTimeout(timer);
        reject(new Error('Codex app-server interaction ended before the request completed.'));
      }
      this.pendingRequests.clear();
      if (active && !active.finished) {
        this.finishActiveRequest(message ? { type: 'error', message } : null);
      }
    });
  }

  handleChildShutdown(message) {
    if (!message && this.closed) return;
    this.destroy('child-shutdown');
    if (this.activeRequest && !this.activeRequest.finished) {
      this.finishActiveRequest({ type: 'error', message: message || 'Codex app-server interaction failed.' });
    }
  }

  handleServerRequest(message) {
    const method = message?.method;
    const id = message?.id;
    if (id == null || !method) return;

    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'execCommandApproval' ||
      method === 'applyPatchApproval'
    ) {
      this.sendResponse(id, { decision: 'denied' });
      return;
    }

    if (method === 'item/permissions/requestApproval') {
      this.sendResponse(id, { permissions: {}, scope: 'turn' });
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      this.sendResponse(id, { answers: {} });
      return;
    }

    if (method === 'mcpServer/elicitation/request') {
      this.sendResponse(id, { action: 'cancel', content: null, _meta: null });
      return;
    }

    if (method === 'item/tool/call') {
      this.sendResponse(id, { contentItems: [], success: false });
      return;
    }

    this.sendErrorResponse(id, `Unsupported app-server request: ${method}`, -32601);
  }

  handleNotification(message) {
    const method = message?.method;
    const params = message?.params || {};
    const active = this.activeRequest;
    if (!method) return;

    if (method === 'thread/started') {
      this.currentThreadId = params?.thread?.id || this.currentThreadId;
      this.threadReady = true;
      if (active && !active.finished) {
        sendEvent(active.res, { type: 'meta', source: 'codex', sessionId: this.currentThreadId });
        if (active.expectSessionCreated && this.currentThreadId && !active.sentSessionCreated) {
          active.sentSessionCreated = true;
          sendEvent(active.res, { type: 'session_created', source: 'codex', rawSessionId: this.currentThreadId });
        }
      }
      return;
    }

    if (!active || active.finished) return;

    if (method === 'turn/started') {
      sendEvent(active.res, {
        type: 'status',
        message: active.turnStartedMessage || 'Codex resumed the selected session.',
      });
      return;
    }

    if (method === 'item/agentMessage/delta' && params?.delta) {
      sendEvent(active.res, {
        type: 'assistant_delta',
        text: params.delta,
        itemId: params.itemId || '',
      });
      return;
    }

    if (method === 'item/started' && params?.item?.type === 'commandExecution') {
      sendEvent(active.res, buildCodexCommandStartEvent(params.item));
      return;
    }

    if (method === 'item/completed' && params?.item?.type === 'commandExecution') {
      sendEvent(active.res, buildCodexCommandResultEvent(params.item, formatAppServerCommandResult));
      return;
    }

    if (method === 'item/completed' && params?.item?.type === 'fileChange') {
      sendEvent(active.res, buildCodexFileChangeEvent(params.item, formatAppServerFileChanges));
      return;
    }

    if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
      sendEvent(active.res, {
        type: 'assistant_final',
        text: params.item.text || '',
        itemId: params.item.id || '',
        phase: params.item.phase || '',
      });
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      const usageMessage = buildCodexTokenUsageMessage(params?.tokenUsage);
      if (usageMessage) {
        sendEvent(active.res, { type: 'status', message: usageMessage });
      }
      return;
    }

    if (method === 'error') {
      const details = params?.message || params?.error || 'Codex app-server interaction failed.';
      sendEvent(active.res, { type: 'error', message: truncateText(normalizeText(details), 800) });
      return;
    }

    if (method === 'turn/completed') {
      active.turnCompleted = true;
      this.lastTurnCompletedAt = Date.now();
      this.needsFingerprintRefresh = true;
      this.scheduleFingerprintRefresh();
      sendEvent(active.res, { type: 'status', message: 'Codex turn completed.' });
      this.finishActiveRequest({ type: 'done', exitCode: 0 });
    }
  }

  scheduleFingerprintRefresh() {
    if (this.fingerprintRefreshTimer) {
      clearTimeout(this.fingerprintRefreshTimer);
      this.fingerprintRefreshTimer = null;
    }
    this.fingerprintRefreshTimer = setTimeout(async () => {
      this.fingerprintRefreshTimer = null;
      const fingerprint = await resolveCodexTranscriptFingerprint({
        locator: this.locator,
        config: this.config,
      });
      if (fingerprint) {
        this.transcriptFingerprint = fingerprint;
      }
      this.needsFingerprintRefresh = false;
    }, 1200);
    this.fingerprintRefreshTimer.unref?.();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  scheduleIdleTimer() {
    this.clearIdleTimer();
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      console.warn(`[session-dashboard] Disposing idle warm Codex worker ${this.describeContext()}`);
      this.destroy('idle-timeout');
    }, CODEX_WARM_IDLE_TTL_MS);
    this.idleTimer.unref?.();
  }

  sendStatusToActive(message) {
    const active = this.activeRequest;
    if (!active || active.finished || active.clientDisconnected) return;
    sendEvent(active.res, { type: 'status', message });
  }

  createActiveRequest(res, req) {
    let resolveCompletion;
    const active = {
      res,
      req,
      finished: false,
      clientDisconnected: false,
      sentSessionCreated: false,
      expectSessionCreated: false,
      turnCompleted: false,
      turnStartedMessage: 'Codex resumed the selected session.',
      completionPromise: new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
      resolveCompletion: () => resolveCompletion?.(),
      onAbort: null,
      onClose: null,
    };

    active.onAbort = () => {
      if (active.finished) return;
      active.clientDisconnected = true;
      this.finishActiveRequest(null);
      this.destroy('client-aborted');
    };

    active.onClose = () => {
      if (active.finished) return;
      active.clientDisconnected = true;
      this.finishActiveRequest(null);
      this.destroy('client-closed');
    };

    req.on('aborted', active.onAbort);
    res.on('close', active.onClose);
    return active;
  }

  finishActiveRequest(payload) {
    const active = this.activeRequest;
    if (!active || active.finished) return;
    active.finished = true;
    active.req.off('aborted', active.onAbort);
    active.res.off('close', active.onClose);
    this.activeRequest = null;
    if (!active.clientDisconnected) {
      if (payload) sendEvent(active.res, payload);
      active.res.end();
    }
    active.resolveCompletion();
    if (!this.closed) {
      this.scheduleIdleTimer();
    }
  }

  writeMessage(message) {
    if (this.closed || this.child.stdin.destroyed) {
      throw new Error('Codex app-server stdin is unavailable.');
    }
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  sendRequest(method, params, timeoutMs = CODEX_REQUEST_TIMEOUT_MS) {
    const id = String(this.nextRequestId++);
    const startedAt = Date.now();
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        console.warn(`[session-dashboard] Codex ${method} timed out after ${timeoutMs}ms ${this.describeContext()}`);
        rejectRequest(new Error(`Timed out waiting for ${method} response.`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
        method,
        startedAt,
      });
      try {
        this.writeMessage({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        rejectRequest(err);
      }
    });
  }

  sendNotification(method, params) {
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  sendResponse(id, result) {
    this.writeMessage({ id, result });
  }

  sendErrorResponse(id, message, code = -32603) {
    this.writeMessage({
      id,
      error: {
        code,
        message,
      },
    });
  }

  async ensureInitialized(res) {
    if (this.initialized) {
      sendEvent(res, { type: 'meta', source: 'codex', sessionId: this.currentThreadId || '' });
      sendEvent(res, { type: 'status', message: 'Reusing warm Codex worker.' });
      return;
    }
    const initResult = await this.sendRequest('initialize', {
      clientInfo: codexClientInfo(this.command),
      capabilities: {
        experimentalApi: true,
      },
    });
    this.sendNotification('initialized');
    this.initialized = true;
    sendEvent(res, { type: 'meta', source: 'codex', sessionId: this.currentThreadId || '' });
    sendEvent(res, {
      type: 'status',
      message: `Connected to Codex app-server (${initResult?.platformOs || 'unknown platform'}).`,
    });
  }

  async ensureResumed(active, options) {
    if (this.threadReady && this.currentThreadId === options.threadTarget.rawSessionId) {
      sendEvent(active.res, {
        type: 'status',
        message: 'Warm Codex session state is already loaded.',
      });
      active.turnStartedMessage = 'Codex continued the selected session.';
      return;
    }

    let lastResumeError = null;
    for (let attempt = 1; attempt <= CODEX_THREAD_RESUME_MAX_ATTEMPTS; attempt += 1) {
      const resumeStartedAt = Date.now();
      const resumeHeartbeat = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - resumeStartedAt) / 1000);
        sendEvent(active.res, {
          type: 'status',
          message: `Still waiting for Codex session resume (${elapsedSec}s)...`,
        });
      }, CODEX_THREAD_RESUME_STATUS_INTERVAL_MS);
      resumeHeartbeat.unref?.();
      sendEvent(active.res, {
        type: 'status',
        message: attempt === 1
          ? 'Resuming selected Codex session...'
          : `Retrying Codex session resume (${attempt}/${CODEX_THREAD_RESUME_MAX_ATTEMPTS})...`,
      });
      try {
        const thread = await this.sendRequest('thread/resume', {
          threadId: options.threadTarget.rawSessionId,
          cwd: options.cwd,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          persistExtendedHistory: true,
        }, CODEX_THREAD_RESUME_TIMEOUT_MS);
        this.currentThreadId = thread?.thread?.id || options.threadTarget.rawSessionId;
        this.threadReady = true;
        this.transcriptFingerprint = options.transcriptFingerprint || this.transcriptFingerprint;
        this.needsFingerprintRefresh = false;
        active.turnStartedMessage = 'Codex resumed the selected session.';
        clearInterval(resumeHeartbeat);
        return;
      } catch (err) {
        lastResumeError = err;
        clearInterval(resumeHeartbeat);
        if (attempt >= CODEX_THREAD_RESUME_MAX_ATTEMPTS) {
          throw err;
        }
        sendEvent(active.res, {
          type: 'status',
          message: `${err.message || 'Codex resume failed.'} Retrying...`,
        });
        await delay(CODEX_THREAD_RESUME_RETRY_DELAY_MS);
      }
    }
    if (lastResumeError) throw lastResumeError;
  }

  canReuse(reuseKey, fingerprint) {
    if (this.closed) return { ok: false, reason: 'closed' };
    if (this.reuseKey !== reuseKey) return { ok: false, reason: 'session-mismatch' };
    if (this.activeRequest) return { ok: false, reason: 'busy' };
    if (!fingerprint || !this.transcriptFingerprint || this.transcriptFingerprint === fingerprint) {
      return { ok: true, reason: 'exact-match' };
    }
    const withinGrace = this.needsFingerprintRefresh &&
      (Date.now() - this.lastTurnCompletedAt) <= CODEX_WARM_SELF_REFRESH_GRACE_MS;
    if (withinGrace) {
      this.transcriptFingerprint = fingerprint;
      this.needsFingerprintRefresh = false;
      return { ok: true, reason: 'self-refresh-grace' };
    }
    return { ok: false, reason: 'transcript-changed' };
  }

  async runInteraction(res, req, options) {
    if (this.activeRequest) {
      throw new Error('Warm Codex worker is busy.');
    }
    this.clearIdleTimer();
    const active = this.createActiveRequest(res, req);
    this.activeRequest = active;

    try {
      await this.ensureInitialized(res);
      await this.ensureResumed(active, options);

      const threadId = this.currentThreadId || options.threadTarget.rawSessionId;
      if (!threadId) {
        throw new Error('Codex app-server did not return a thread id.');
      }

      sendEvent(res, { type: 'meta', source: 'codex', sessionId: threadId });

      const input = buildCodexInputItems(options.text, options.imageFiles);
      if (!input.length) {
        throw new Error('No Codex input items were generated for this interaction.');
      }

      await this.sendRequest('turn/start', {
        threadId,
        input,
        cwd: options.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      });

      await active.completionPromise;
    } catch (err) {
      this.finishActiveRequest({ type: 'error', message: err.message || 'Codex app-server interaction failed.' });
      this.destroy('warm-interaction-error');
    }
  }

  destroy(reason = 'shutdown') {
    if (this.closed) return;
    this.closed = true;
    clearSharedCodexWarmWorker(this);
    this.clearIdleTimer();
    if (this.fingerprintRefreshTimer) {
      clearTimeout(this.fingerprintRefreshTimer);
      this.fingerprintRefreshTimer = null;
    }
    if (!this.child.killed && this.child.exitCode == null) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        return;
      }
      this.forceKillTimer = setTimeout(() => {
        if (!this.child.killed && this.child.exitCode == null) {
          try {
            this.child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 1500);
      this.forceKillTimer.unref?.();
    }
    if (reason && reason !== 'idle-timeout') {
      console.warn(`[session-dashboard] Disposing warm Codex worker (${reason}) ${this.describeContext()}`);
    }
  }
}

async function streamCodexAppServerColdInteraction(res, req, options) {
  return new Promise((resolve) => {
    let finished = false;
    let clientDisconnected = false;
    let forcedKillTimer = null;
    let nextRequestId = 1;
    let turnCompleted = false;
    let sentSessionCreated = false;
    let currentThreadId = '';
    const pendingRequests = new Map();
    const childEnv = buildCodexAppServerEnv(options.env);
    const child = spawn(options.command, ['app-server', '--analytics-default-enabled'], {
      cwd: options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer);
        forcedKillTimer = null;
      }
      for (const { reject, timer } of pendingRequests.values()) {
        clearTimeout(timer);
        reject(new Error('Codex app-server interaction ended before the request completed.'));
      }
      pendingRequests.clear();
      if (!clientDisconnected) {
        if (payload) sendEvent(res, payload);
        res.end();
      }
      resolve();
    };

    const stopChild = () => {
      if (child.killed || child.exitCode != null) return;
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
      forcedKillTimer = setTimeout(() => {
        if (!child.killed && child.exitCode == null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 1500);
      forcedKillTimer.unref?.();
    };

    const writeMessage = (message) => {
      if (finished || clientDisconnected || child.stdin.destroyed) {
        throw new Error('Codex app-server stdin is unavailable.');
      }
      child.stdin.write(JSON.stringify(message) + '\n');
    };

    const sendRequest = (method, params, timeoutMs = CODEX_REQUEST_TIMEOUT_MS) => {
      const id = String(nextRequestId++);
      const startedAt = Date.now();
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          console.warn(
            `[session-dashboard] Codex ${method} timed out after ${timeoutMs}ms ` +
            `(cwd=${options.cwd}, thread=${options.threadTarget?.rawSessionId || ''})`,
          );
          rejectRequest(new Error(`Timed out waiting for ${method} response.`));
        }, timeoutMs);
        pendingRequests.set(id, {
          resolve: resolveRequest,
          reject: rejectRequest,
          timer,
          method,
          startedAt,
        });
        try {
          writeMessage({ id, method, params });
        } catch (err) {
          clearTimeout(timer);
          pendingRequests.delete(id);
          rejectRequest(err);
        }
      });
    };

    const sendNotification = (method, params) => {
      writeMessage(params === undefined ? { method } : { method, params });
    };

    const sendResponse = (id, result) => {
      writeMessage({ id, result });
    };

    const sendErrorResponse = (id, message, code = -32603) => {
      writeMessage({
        id,
        error: {
          code,
          message,
        },
      });
    };

    const handleServerRequest = (message) => {
      const method = message?.method;
      const id = message?.id;
      if (id == null || !method) return;

      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval' ||
        method === 'execCommandApproval' ||
        method === 'applyPatchApproval'
      ) {
        sendResponse(id, { decision: 'denied' });
        return;
      }

      if (method === 'item/permissions/requestApproval') {
        sendResponse(id, { permissions: {}, scope: 'turn' });
        return;
      }

      if (method === 'item/tool/requestUserInput') {
        sendResponse(id, { answers: {} });
        return;
      }

      if (method === 'mcpServer/elicitation/request') {
        sendResponse(id, { action: 'cancel', content: null, _meta: null });
        return;
      }

      if (method === 'item/tool/call') {
        sendResponse(id, { contentItems: [], success: false });
        return;
      }

      sendErrorResponse(id, `Unsupported app-server request: ${method}`, -32601);
    };

    const handleNotification = (message) => {
      const method = message?.method;
      const params = message?.params || {};
      if (!method) return;

      if (method === 'thread/started') {
        currentThreadId = params?.thread?.id || currentThreadId;
        sendEvent(res, { type: 'meta', source: 'codex', sessionId: currentThreadId });
        if (options.threadTarget.mode === 'start' && currentThreadId && !sentSessionCreated) {
          sentSessionCreated = true;
          sendEvent(res, { type: 'session_created', source: 'codex', rawSessionId: currentThreadId });
        }
        return;
      }

      if (method === 'turn/started') {
        sendEvent(res, {
          type: 'status',
          message: options.threadTarget.mode === 'start'
            ? 'Codex started a new session.'
            : 'Codex resumed the selected session.',
        });
        return;
      }

      if (method === 'item/agentMessage/delta' && params?.delta) {
        sendEvent(res, {
          type: 'assistant_delta',
          text: params.delta,
          itemId: params.itemId || '',
        });
        return;
      }

      if (method === 'item/started' && params?.item?.type === 'commandExecution') {
        sendEvent(res, buildCodexCommandStartEvent(params.item));
        return;
      }

      if (method === 'item/completed' && params?.item?.type === 'commandExecution') {
        sendEvent(res, buildCodexCommandResultEvent(params.item, formatAppServerCommandResult));
        return;
      }

      if (method === 'item/completed' && params?.item?.type === 'fileChange') {
        sendEvent(res, buildCodexFileChangeEvent(params.item, formatAppServerFileChanges));
        return;
      }

      if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
        sendEvent(res, {
          type: 'assistant_final',
          text: params.item.text || '',
          itemId: params.item.id || '',
          phase: params.item.phase || '',
        });
        return;
      }

      if (method === 'thread/tokenUsage/updated') {
        const usageMessage = buildCodexTokenUsageMessage(params?.tokenUsage);
        if (usageMessage) {
          sendEvent(res, { type: 'status', message: usageMessage });
        }
        return;
      }

      if (method === 'error') {
        const details = params?.message || params?.error || 'Codex app-server interaction failed.';
        sendEvent(res, { type: 'error', message: truncateText(normalizeText(details), 800) });
        return;
      }

      if (method === 'turn/completed') {
        turnCompleted = true;
        sendEvent(res, { type: 'status', message: 'Codex turn completed.' });
        stopChild();
        finish({ type: 'done', exitCode: 0 });
      }
    };

    req.on('aborted', () => {
      clientDisconnected = true;
      stopChild();
    });

    res.on('close', () => {
      if (finished) return;
      clientDisconnected = true;
      stopChild();
    });

    processJsonLines(child.stdout, (line) => {
      if (clientDisconnected || finished) return;
      const message = safeJsonParse(line);
      if (!message) {
        sendEvent(res, { type: 'status', message: truncateText(line, 400) });
        return;
      }

      if (Object.prototype.hasOwnProperty.call(message, 'id') &&
          (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) {
        const id = String(message.id);
        const pending = pendingRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingRequests.delete(id);
        const elapsedMs = Date.now() - (pending.startedAt || Date.now());
        if (elapsedMs >= 5000) {
          console.warn(
            `[session-dashboard] Codex ${pending.method} completed in ${elapsedMs}ms ` +
            `(cwd=${options.cwd}, thread=${options.threadTarget?.rawSessionId || ''})`,
          );
        }
        if (message.error) {
          pending.reject(new Error(message.error.message || `${pending.method} failed.`));
          return;
        }
        pending.resolve(message.result);
        return;
      }

      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        handleServerRequest(message);
        return;
      }

      if (message.method) {
        handleNotification(message);
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const lines = chunk
        .toString('utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !shouldIgnoreCodexAppServerLogLine(line));

      if (!lines.length) return;

      const text = lines.join('\n');
      stderr += (stderr ? '\n' : '') + text;
      if (clientDisconnected || finished) return;

      for (const line of lines) {
        sendEvent(res, { type: 'status', message: truncateText(line, 400) });
      }
    });

    child.on('error', (err) => {
      finish({ type: 'error', message: err.message || 'Failed to start Codex app-server.' });
    });

    child.on('close', (code) => {
      if (finished) return;
      if (turnCompleted || code === 0) {
        finish({ type: 'done', exitCode: code || 0 });
        return;
      }
      finish({
        type: 'error',
        message: stderr || `Codex app-server exited with code ${code}`,
      });
    });

    (async () => {
      const initResult = await sendRequest('initialize', {
        clientInfo: codexClientInfo(options.command),
        capabilities: {
          experimentalApi: true,
        },
      });
      sendNotification('initialized');
      sendEvent(res, { type: 'meta', source: 'codex', sessionId: currentThreadId || '' });
      sendEvent(res, {
        type: 'status',
        message: `Connected to Codex app-server (${initResult?.platformOs || 'unknown platform'}).`,
      });

      let threadId = options.threadTarget.rawSessionId;
      if (options.threadTarget.mode === 'start') {
        const thread = await sendRequest('thread/start', {
          cwd: options.cwd,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          experimentalRawEvents: false,
          persistExtendedHistory: true,
        });
        threadId = thread?.thread?.id || threadId;
        currentThreadId = threadId || currentThreadId;
        if (threadId && !sentSessionCreated) {
          sentSessionCreated = true;
          sendEvent(res, { type: 'session_created', source: 'codex', rawSessionId: threadId });
        }
      } else {
        let thread = null;
        let lastResumeError = null;
        for (let attempt = 1; attempt <= CODEX_THREAD_RESUME_MAX_ATTEMPTS; attempt += 1) {
          const resumeStartedAt = Date.now();
          const resumeHeartbeat = setInterval(() => {
            const elapsedSec = Math.floor((Date.now() - resumeStartedAt) / 1000);
            sendEvent(res, {
              type: 'status',
              message: `Still waiting for Codex session resume (${elapsedSec}s)...`,
            });
          }, CODEX_THREAD_RESUME_STATUS_INTERVAL_MS);
          resumeHeartbeat.unref?.();
          sendEvent(res, {
            type: 'status',
            message: attempt === 1
              ? 'Resuming selected Codex session...'
              : `Retrying Codex session resume (${attempt}/${CODEX_THREAD_RESUME_MAX_ATTEMPTS})...`,
          });
          try {
            thread = await sendRequest('thread/resume', {
              threadId,
              cwd: options.cwd,
              approvalPolicy: 'never',
              sandbox: 'danger-full-access',
              persistExtendedHistory: true,
            }, CODEX_THREAD_RESUME_TIMEOUT_MS);
            break;
          } catch (err) {
            lastResumeError = err;
            if (attempt >= CODEX_THREAD_RESUME_MAX_ATTEMPTS) {
              throw err;
            }
            sendEvent(res, {
              type: 'status',
              message: `${err.message || 'Codex resume failed.'} Retrying...`,
            });
            await delay(CODEX_THREAD_RESUME_RETRY_DELAY_MS);
          } finally {
            clearInterval(resumeHeartbeat);
          }
        }
        if (!thread && lastResumeError) {
          throw lastResumeError;
        }
        threadId = thread?.thread?.id || threadId;
        currentThreadId = threadId || currentThreadId;
      }

      if (!threadId) {
        throw new Error('Codex app-server did not return a thread id.');
      }

      const input = buildCodexInputItems(options.text, options.imageFiles);
      if (!input.length) {
        throw new Error('No Codex input items were generated for this interaction.');
      }

      await sendRequest('turn/start', {
        threadId,
        input,
        cwd: options.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      });
    })().catch((err) => {
      finish({ type: 'error', message: err.message || 'Codex app-server interaction failed.' });
      stopChild();
    });
  });
}

async function streamCodexAppServerInteraction(res, req, options) {
  if (!canUseWarmCodexWorker(options)) {
    return streamCodexAppServerColdInteraction(res, req, options);
  }

  const transcriptFingerprint = await resolveCodexTranscriptFingerprint(options);
  const reuseKey = buildCodexWarmReuseKey(options);
  const currentWorker = sharedCodexWarmWorker;

  if (currentWorker) {
    const reuseDecision = currentWorker.canReuse(reuseKey, transcriptFingerprint);
    if (!reuseDecision.ok) {
      if (reuseDecision.reason !== 'busy') {
        console.warn(
          `[session-dashboard] Warm Codex worker invalidated (${reuseDecision.reason}) ` +
          `(cwd=${options.cwd}, thread=${options.threadTarget?.rawSessionId || ''})`,
        );
        currentWorker.destroy(reuseDecision.reason);
      } else {
        sendEvent(res, {
          type: 'status',
          message: 'Warm Codex worker is busy; falling back to a fresh session resume.',
        });
        return streamCodexAppServerColdInteraction(res, req, options);
      }
    }
  }

  if (!sharedCodexWarmWorker) {
    sharedCodexWarmWorker = new CodexWarmWorker({
      command: options.command,
      cwd: options.cwd,
      env: options.env || {},
      locator: options.locator,
      config: options.config,
      reuseKey,
      transcriptFingerprint,
    });
  }

  return sharedCodexWarmWorker.runInteraction(res, req, {
    ...options,
    transcriptFingerprint,
  });
}

function parseClaudeLine(line, res) {
  const obj = safeJsonParse(line);
  if (!obj) {
    sendEvent(res, { type: 'status', message: truncateText(line, 400) });
    return;
  }

  if (obj.type === 'system' && obj.subtype === 'init') {
    sendEvent(res, { type: 'meta', source: 'claude', sessionId: obj.session_id });
    sendEvent(res, { type: 'session_created', source: 'claude', rawSessionId: obj.session_id });
    return;
  }

  if (obj.type === 'stream_event') {
    const event = obj.event || {};
    if (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta' &&
      event.delta?.text
    ) {
      sendEvent(res, { type: 'assistant_delta', text: event.delta.text });
      return;
    }
    if (event.type === 'message_start') {
      sendEvent(res, { type: 'status', message: 'Claude is responding...' });
    }
    return;
  }

  if (obj.type === 'assistant') {
    sendEvent(res, {
      type: 'assistant_final',
      text: extractClaudeAssistantText(obj.message),
    });
    return;
  }

  if (obj.type === 'result' && obj.is_error) {
    sendEvent(res, {
      type: 'error',
      message: (obj.errors || []).join('\n') || obj.result || 'Claude interaction failed.',
    });
  }
}

function parseCopilotLine(line, res) {
  const obj = safeJsonParse(line);
  if (!obj) {
    sendEvent(res, { type: 'status', message: truncateText(line, 400) });
    return;
  }

  if (obj.type === 'session.tools_updated') {
    sendEvent(res, {
      type: 'meta',
      source: 'copilot',
      model: obj.data?.model || '',
    });
    return;
  }

  if (obj.type === 'assistant.message_delta' && obj.data?.deltaContent) {
    sendEvent(res, { type: 'assistant_delta', text: obj.data.deltaContent });
    return;
  }

  if (obj.type === 'assistant.message') {
    sendEvent(res, {
      type: 'assistant_final',
      text: extractCopilotAssistantText(obj.data),
    });
    return;
  }

  if (obj.type === 'tool.execution_start') {
    sendEvent(res, {
      type: 'tool_event',
      message: `${obj.data?.toolName || 'Tool'} started...`,
    });
    return;
  }

  if (obj.type === 'tool.execution_complete') {
    const success = obj.data?.success !== false;
    sendEvent(res, {
      type: 'tool_event',
      message: success
        ? `${obj.data?.toolName || 'Tool'} completed.`
        : `${obj.data?.toolName || 'Tool'} failed.`,
    });
    return;
  }

  if (obj.type === 'result' && obj.exitCode && obj.exitCode !== 0) {
    sendEvent(res, {
      type: 'error',
      message: 'Copilot interaction exited with an error.',
    });
  }
}

async function streamProcess(res, req, command, args, options) {
  return new Promise((resolve) => {
    let finished = false;
    let clientDisconnected = false;
    let forcedKillTimer = null;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer);
        forcedKillTimer = null;
      }
      if (!clientDisconnected) {
        if (payload) sendEvent(res, payload);
        res.end();
      }
      resolve();
    };

    const stopChild = () => {
      if (finished || child.killed) return;
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
      forcedKillTimer = setTimeout(() => {
        if (!finished && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 1500);
      forcedKillTimer.unref?.();
    };

    req.on('aborted', () => {
      clientDisconnected = true;
      stopChild();
    });

    res.on('close', () => {
      if (finished) return;
      clientDisconnected = true;
      stopChild();
    });

    processJsonLines(child.stdout, (line) => {
      if (clientDisconnected || finished) return;
      options.parseLine(line, res);
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      if (clientDisconnected || finished) return;
      sendEvent(res, { type: 'status', message: truncateText(text.trim(), 400) });
    });

    child.on('error', (err) => {
      finish({ type: 'error', message: err.message });
    });

    child.on('close', (code) => {
      if (code && code !== 0) {
        finish({
          type: 'error',
          message: stderr.trim() || `${command} exited with code ${code}`,
        });
        return;
      }
      finish({ type: 'done', exitCode: code || 0 });
    });
  });
}

export async function handleInteractionRequest(req, res, { project, locator, config }) {
  beginNdjson(res);

  try {
    const body = await readJsonBody(req);
    const text = typeof body.text === 'string' ? body.text : '';
    const images = Array.isArray(body.images) ? body.images : [];
    const sessionMeta = body.sessionMeta && typeof body.sessionMeta === 'object' ? body.sessionMeta : null;
    const claudeProfileOverride = typeof body.claudeProfileOverride === 'string' ? body.claudeProfileOverride.trim() : '';
    const { dir: uploadDir, files: imageFiles } = await materializeImages(images);
    const cwd = (await pathExists(defaultCwd(locator))) ? defaultCwd(locator) : WORKSPACE_ROOT;

    if (images.length > 0) {
      sendEvent(res, {
        type: 'image_state',
        selectedCount: images.length,
        decodedCount: imageFiles.length,
        transport: imageFiles.length > 0 ? 'prepared' : 'failed',
      });
    }

    if (images.length > 0 && imageFiles.length === 0) {
      sendEvent(res, {
        type: 'error',
        message: 'Image upload failed before reaching the backend. No valid image payload was decoded.',
      });
      res.end();
      return;
    }

    if (imageFiles.length > 0 && imageFiles.length < images.length) {
      sendEvent(res, {
        type: 'status',
        message: `Only ${imageCountText(imageFiles.length)} could be decoded from ${images.length} uploaded item(s).`,
      });
    }

    if (project.projectPath !== locator.projectPath) {
      sendEvent(res, { type: 'error', message: 'Session does not belong to the selected project.' });
      res.end();
      return;
    }

    if (locator.source === 'codex') {
      const codexBinary = await resolveCodexBinary();
      const threadTarget = resolveCodexThreadTarget(locator, sessionMeta);
      sendEvent(res, { type: 'status', message: 'Starting Codex interaction...' });
      if (imageFiles.length > 0) {
        sendEvent(res, {
          type: 'image_state',
          selectedCount: images.length,
          decodedCount: imageFiles.length,
          transport: 'native',
        });
        sendEvent(res, {
          type: 'status',
          message: `Attached ${imageCountText(imageFiles.length)} to the Codex request.`,
        });
      }
      await streamCodexAppServerInteraction(res, req, {
        command: codexBinary,
        cwd,
        text,
        imageFiles,
        threadTarget,
        locator,
        config,
        env: {
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE:
            process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || DEFAULT_CODEX_ORIGINATOR,
        },
      });
      return;
    }

    if (locator.source === 'claude') {
      const prompt = buildPrompt(text, imageFiles, false);
      const args = createClaudeArgs(locator, prompt, uploadDir);
      const claudeLaunch = await resolveClaudeLaunchContext(locator, sessionMeta, claudeProfileOverride);
      sendEvent(res, { type: 'status', message: 'Starting Claude interaction...' });
      if (claudeLaunch.profileLabel || claudeLaunch.anthropicModel) {
        const summary = [
          claudeLaunch.profileLabel ? `profile=${claudeLaunch.profileLabel}` : '',
          claudeLaunch.anthropicModel ? `model=${claudeLaunch.anthropicModel}` : '',
        ].filter(Boolean).join(' ');
        if (summary) {
          sendEvent(res, { type: 'status', message: `Claude launch context: ${summary}` });
        }
      }
      if (imageFiles.length > 0) {
        sendEvent(res, {
          type: 'image_state',
          selectedCount: images.length,
          decodedCount: imageFiles.length,
          transport: 'local-file',
        });
        sendEvent(res, {
          type: 'status',
          message: `Saved ${imageCountText(imageFiles.length)} to local temp files for Claude to inspect.`,
        });
      }
      await streamProcess(res, req, 'claude', args, {
        cwd,
        env: claudeLaunch.env || {},
        parseLine: parseClaudeLine,
      });
      if (claudeLaunch.profile || claudeLaunch.baseUrl || claudeLaunch.anthropicModel) {
        await recordClaudeProvenance(locator, claudeLaunch);
      }
      return;
    }

    if (locator.source === 'copilot') {
      const token = await getCopilotToken();
      if (!token) {
        sendEvent(res, {
          type: 'error',
          message: 'Copilot token not found in the local Copilot config.',
        });
        res.end();
        return;
      }

      const prompt = buildPrompt(text, imageFiles, false);
      const args = createCopilotArgs(locator, prompt, uploadDir);
      sendEvent(res, { type: 'status', message: 'Starting Copilot interaction...' });
      if (imageFiles.length > 0) {
        sendEvent(res, {
          type: 'image_state',
          selectedCount: images.length,
          decodedCount: imageFiles.length,
          transport: 'local-file',
        });
        sendEvent(res, {
          type: 'status',
          message: `Saved ${imageCountText(imageFiles.length)} to local temp files for Copilot to inspect.`,
        });
      }
      if (locator.draft && locator.rawSessionId) {
        sendEvent(res, { type: 'session_created', source: 'copilot', rawSessionId: locator.rawSessionId });
      }
      await streamProcess(res, req, COPILOT_BINARY, args, {
        cwd,
        env: { COPILOT_GITHUB_TOKEN: token },
        parseLine: parseCopilotLine,
      });
      return;
    }

    sendEvent(res, { type: 'error', message: `Unsupported source: ${locator.source}` });
    res.end();
  } catch (err) {
    sendEvent(res, { type: 'error', message: err.message || 'Interaction failed.' });
    res.end();
  }
}
