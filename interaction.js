import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 6;

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

function extractCopilotModel(message) {
  if (typeof message !== 'string') return '';
  const match = message.match(/Model changed to:\s*(.+)$/);
  return match ? match[1].trim() : message.trim();
}

async function getCopilotToken(runtimeConfig) {
  try {
    const raw = await fsp.readFile(runtimeConfig.copilotConfigFile, 'utf-8');
    const config = JSON.parse(raw);
    const token = Object.values(config.copilot_tokens || {})[0];
    return typeof token === 'string' && token ? token : '';
  } catch {
    return '';
  }
}

export async function getInteractionCapabilities(runtimeConfig) {
  const copilotToken = await getCopilotToken(runtimeConfig);
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

function createCopilotArgs(locator, prompt, uploadDir, runtimeConfig) {
  const args = [
    '--config-dir',
    runtimeConfig.copilotConfigDir,
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

function defaultCwd(locator, runtimeConfig) {
  return locator.projectPath && locator.projectPath !== '(unknown)'
    ? locator.projectPath
    : runtimeConfig.workspaceRoot;
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
  if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
    sendEvent(res, { type: 'assistant_final', text: obj.item.text || '' });
    return;
  }
  if (obj.type === 'turn.completed') {
    sendEvent(res, { type: 'status', message: 'Codex turn completed.' });
  }
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      if (payload) sendEvent(res, payload);
      res.end();
      resolve();
    };

    req.on('close', () => {
      if (!finished) {
        child.kill('SIGTERM');
      }
    });

    processJsonLines(child.stdout, (line) => {
      options.parseLine(line, res);
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      stderr += text;
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
    const { dir: uploadDir, files: imageFiles } = await materializeImages(images);
    const preferredCwd = defaultCwd(locator, config);
    const cwd = (await pathExists(preferredCwd)) ? preferredCwd : config.workspaceRoot;

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
      const prompt = buildPrompt(text, imageFiles, true);
      const args = createCodexArgs(locator, prompt, imageFiles);
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
      await streamProcess(res, req, config.codexBin, args, {
        cwd,
        parseLine: parseCodexLine,
      });
      return;
    }

    if (locator.source === 'claude') {
      const prompt = buildPrompt(text, imageFiles, false);
      const args = createClaudeArgs(locator, prompt, uploadDir);
      sendEvent(res, { type: 'status', message: 'Starting Claude interaction...' });
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
      await streamProcess(res, req, config.claudeBin, args, {
        cwd,
        parseLine: parseClaudeLine,
      });
      return;
    }

    if (locator.source === 'copilot') {
      const token = await getCopilotToken(config);
      if (!token) {
        sendEvent(res, {
          type: 'error',
          message: 'Copilot token not found in the local Copilot config.',
        });
        res.end();
        return;
      }

      const prompt = buildPrompt(text, imageFiles, false);
      const args = createCopilotArgs(locator, prompt, uploadDir, config);
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
      await streamProcess(res, req, config.copilotBin, args, {
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
