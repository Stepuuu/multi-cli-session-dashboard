import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, 'server.js');
const CACHE_FILE = path.resolve(__dirname, 'data', 'session-metadata-cache.json');

async function mkdirp(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJsonl(filePath, lines) {
  await mkdirp(path.dirname(filePath));
  await fs.writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
}

async function setMtime(filePath, isoString) {
  const time = new Date(isoString);
  await fs.utimes(filePath, time, time);
}

async function withPreservedCache(fn) {
  let original = null;
  try {
    original = await fs.readFile(CACHE_FILE, 'utf8');
  } catch {
    original = null;
  }

  try {
    return await fn();
  } finally {
    if (original === null) {
      await fs.rm(CACHE_FILE, { force: true });
    } else {
      await fs.writeFile(CACHE_FILE, original, 'utf8');
    }
  }
}

async function startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir }) {
  const port = 36000 + Math.floor(Math.random() * 2000);
  const child = spawn(
    process.execPath,
    [
      SERVER_PATH,
      '--port',
      String(port),
      '--claude-projects-dir',
      claudeProjectsDir,
      '--codex-sessions-dir',
      codexSessionsDir,
      '--copilot-session-state-dir',
      copilotSessionStateDir,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10000);

    const onData = (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(`http://localhost:${port}`)) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve();
      }
    };

    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });

  return {
    port,
    child,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

async function getJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  assert.equal(response.status, 200, `GET ${pathname} failed with ${response.status}`);
  return response.json();
}

test('filters synthetic Claude sessions from project session lists', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-filter-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectDir = path.join(claudeProjectsDir, 'tmp-project');

    await mkdirp(projectDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    await writeJsonl(path.join(projectDir, 'real-session.jsonl'), [
      {
        type: 'user',
        message: { content: [{ type: 'text', text: 'real project question' }] },
        gitBranch: 'main',
        timestamp: '2026-04-11T00:00:00.000Z',
      },
      {
        type: 'assistant',
        message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'answer' }] },
        timestamp: '2026-04-11T00:00:01.000Z',
      },
    ]);

    await writeJsonl(path.join(projectDir, 'agent-warmup.jsonl'), [
      {
        type: 'user',
        message: { content: 'Warmup' },
        gitBranch: 'main',
        timestamp: '2026-04-11T00:00:02.000Z',
      },
      {
        type: 'assistant',
        message: { model: 'gpt-5.4', content: [{ type: 'text', text: 'Ready.' }] },
        timestamp: '2026-04-11T00:00:03.000Z',
      },
    ]);

    await writeJsonl(path.join(projectDir, 'summary-session.jsonl'), [
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: 'Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.\n\nSummarize this conversation.',
            },
          ],
        },
        gitBranch: 'main',
        timestamp: '2026-04-11T00:00:04.000Z',
      },
      {
        type: 'assistant',
        message: { model: 'gpt-5.4', content: [{ type: 'text', text: '<summary>summary</summary>' }] },
        timestamp: '2026-04-11T00:00:05.000Z',
      },
    ]);

    await writeJsonl(path.join(projectDir, 'judge-session.jsonl'), [
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: 'Analyze this conversation and determine: Does the assistant have more autonomous work to do RIGHT NOW?',
            },
          ],
        },
        gitBranch: 'main',
        timestamp: '2026-04-11T00:00:06.000Z',
      },
      {
        type: 'assistant',
        message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'false' }] },
        timestamp: '2026-04-11T00:00:07.000Z',
      },
    ]);

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      assert.equal(projects.length, 1);

      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.deepEqual(
        sessions.map((session) => session.firstPrompt),
        ['real project question'],
      );
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('dedupes Codex sessions that share the same logical raw session id', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-dedupe-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    const olderFile = path.join(codexSessionsDir, '2026', '04', '09', 'older.jsonl');
    const newerFile = path.join(codexSessionsDir, '2026', '04', '10', 'newer.jsonl');

    const olderLines = [
      {
        timestamp: '2026-04-09T14:14:30.000Z',
        type: 'session_meta',
        payload: {
          id: 'shared-codex-session',
          cwd: projectPath,
          timestamp: '2026-04-09T14:14:30.000Z',
          model: 'gpt-5.3-codex',
        },
      },
      {
        timestamp: '2026-04-09T14:14:31.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '讲解一下这个论文，中心思想是什么',
        },
      },
      {
        timestamp: '2026-04-09T14:14:32.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      },
    ];

    const newerLines = [
      {
        timestamp: '2026-04-10T09:18:02.000Z',
        type: 'session_meta',
        payload: {
          id: 'shared-codex-session',
          cwd: projectPath,
          timestamp: '2026-04-09T14:14:30.000Z',
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-10T09:18:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '讲解一下这个论文，中心思想是什么',
        },
      },
      {
        timestamp: '2026-04-10T09:18:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      },
      {
        timestamp: '2026-04-10T09:18:05.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      },
    ];

    await writeJsonl(olderFile, olderLines);
    await writeJsonl(newerFile, newerLines);
    await setMtime(olderFile, '2026-04-09T14:49:06.621Z');
    await setMtime(newerFile, '2026-04-11T12:12:11.044Z');

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      assert.equal(projects.length, 1);

      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].rawSessionId, 'shared-codex-session');
      assert.equal(sessions[0].model, 'gpt-5.4');
      assert.equal(sessions[0].messageCount, 3);
      assert.equal(sessions[0].modified, '2026-04-11T12:12:11.044Z');
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('keeps forked Codex sessions distinct when parent session metadata is embedded', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-codex-fork-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    const parentFile = path.join(codexSessionsDir, '2026', '04', '15', 'parent.jsonl');
    const forkFile = path.join(codexSessionsDir, '2026', '04', '15', 'fork.jsonl');

    await writeJsonl(parentFile, [
      {
        timestamp: '2026-04-15T12:44:14.640Z',
        type: 'session_meta',
        payload: {
          id: 'parent-session',
          cwd: projectPath,
          timestamp: '2026-04-15T12:44:14.640Z',
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-15T12:44:15.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'parent prompt',
        },
      },
      {
        timestamp: '2026-04-15T12:44:16.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      },
    ]);

    await writeJsonl(forkFile, [
      {
        timestamp: '2026-04-15T12:45:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'fork-session',
          forked_from_id: 'parent-session',
          cwd: projectPath,
          timestamp: '2026-04-15T12:45:00.000Z',
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-15T12:45:00.001Z',
        type: 'session_meta',
        payload: {
          id: 'parent-session',
          cwd: projectPath,
          timestamp: '2026-04-15T12:44:14.640Z',
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-15T12:45:00.002Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'fork prompt',
        },
      },
      {
        timestamp: '2026-04-15T12:45:00.003Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      },
    ]);

    await setMtime(parentFile, '2026-04-15T12:44:16.000Z');
    await setMtime(forkFile, '2026-04-15T12:45:01.000Z');

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      assert.equal(projects.length, 1);

      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((session) => session.rawSessionId),
        ['fork-session', 'parent-session'],
      );
      assert.equal(sessions[0].forkedFromId, 'parent-session');
      assert.equal(sessions[1].forkedFromId, '');

      const digest = await getJson(server.port, `/api/sessions-digest/${projects[0].dirName}`);
      assert.equal(digest[0].forkedFromId, 'parent-session');
      assert.equal(digest[1].forkedFromId, '');
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('filters Codex subagent sessions while keeping parent sessions visible', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-codex-subagent-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    const parentFile = path.join(codexSessionsDir, '2026', '04', '16', 'parent.jsonl');
    const childFile = path.join(codexSessionsDir, '2026', '04', '16', 'child.jsonl');

    await writeJsonl(parentFile, [
      {
        timestamp: '2026-04-16T08:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'parent-session',
          cwd: projectPath,
          timestamp: '2026-04-16T08:00:00.000Z',
          model: 'gpt-5.4',
          source: 'cli',
        },
      },
      {
        timestamp: '2026-04-16T08:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'parent prompt',
        },
      },
      {
        timestamp: '2026-04-16T08:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      },
    ]);

    await writeJsonl(childFile, [
      {
        timestamp: '2026-04-16T08:01:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'child-session',
          cwd: projectPath,
          timestamp: '2026-04-16T08:01:00.000Z',
          model: 'gpt-5.4',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'parent-session',
                depth: 1,
                agent_role: 'explorer',
                agent_nickname: 'Curie',
              },
            },
          },
          agent_role: 'explorer',
          agent_nickname: 'Curie',
        },
      },
      {
        timestamp: '2026-04-16T08:01:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'child prompt',
        },
      },
      {
        timestamp: '2026-04-16T08:01:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      },
    ]);

    await setMtime(parentFile, '2026-04-16T08:00:02.000Z');
    await setMtime(childFile, '2026-04-16T08:01:02.000Z');

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      assert.equal(projects.length, 1);

      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.deepEqual(
        sessions.map((session) => session.rawSessionId),
        ['parent-session'],
      );

      const digest = await getJson(server.port, `/api/sessions-digest/${projects[0].dirName}`);
      assert.deepEqual(
        digest.map((session) => session.rawSessionId),
        ['parent-session'],
      );
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('merges hidden Codex subagent transcripts into the parent message timeline', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-codex-subagent-merge-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    const parentFile = path.join(codexSessionsDir, '2026', '04', '16', 'parent.jsonl');
    const childFile = path.join(codexSessionsDir, '2026', '04', '16', 'child.jsonl');

    await writeJsonl(parentFile, [
      {
        timestamp: '2026-04-16T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'parent-session',
          cwd: projectPath,
          timestamp: '2026-04-16T10:00:00.000Z',
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-16T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'parent prompt',
        },
      },
      {
        timestamp: '2026-04-16T10:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          phase: 'commentary',
          message: 'Tracing the code path first.',
        },
      },
      {
        timestamp: '2026-04-16T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
          call_id: 'call-parent-1',
        },
      },
      {
        timestamp: '2026-04-16T10:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-parent-1',
          output: '/tmp/project',
        },
      },
      {
        timestamp: '2026-04-16T10:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'parent answer' }],
        },
      },
    ]);

    await writeJsonl(childFile, [
      {
        timestamp: '2026-04-16T10:00:02.500Z',
        type: 'session_meta',
        payload: {
          id: 'child-session',
          cwd: projectPath,
          timestamp: '2026-04-16T10:00:02.500Z',
          model: 'gpt-5.4',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'parent-session',
                depth: 1,
                agent_role: 'explorer',
                agent_nickname: 'Curie',
              },
            },
          },
          agent_role: 'explorer',
          agent_nickname: 'Curie',
        },
      },
      {
        timestamp: '2026-04-16T10:00:02.600Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-child-1',
          model_context_window: 258400,
        },
      },
      {
        timestamp: '2026-04-16T10:00:02.700Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'inspect files',
        },
      },
      {
        timestamp: '2026-04-16T10:00:02.800Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          phase: 'commentary',
          message: 'Checking files now.',
        },
      },
      {
        timestamp: '2026-04-16T10:00:02.900Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"ls -la"}',
          call_id: 'call-child-1',
        },
      },
      {
        timestamp: '2026-04-16T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-child-1',
          output: 'total 0',
        },
      },
      {
        timestamp: '2026-04-16T10:00:03.200Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-child-1',
          completed_at: 1776333603,
          duration_ms: 600,
        },
      },
    ]);

    await setMtime(parentFile, '2026-04-16T10:00:05.000Z');
    await setMtime(childFile, '2026-04-16T10:00:03.200Z');

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.deepEqual(sessions.map((session) => session.rawSessionId), ['parent-session']);

      const merged = await getJson(
        server.port,
        `/api/messages/${projects[0].dirName}/${encodeURIComponent(sessions[0].sessionId)}?offset=0&limit=50&direction=newest`,
      );
      const subagentGroup = merged.messages.find((message) => message.type === 'subagent_group');
      assert.ok(subagentGroup, 'expected merged subagent group message');
      assert.equal(subagentGroup.subagent.nickname, 'Curie');
      assert.equal(subagentGroup.subagent.role, 'explorer');
      assert.equal(subagentGroup.subagent.parentThreadId, 'parent-session');
      assert.equal(Array.isArray(subagentGroup.messages), true);
      assert.equal(subagentGroup.messages.some((message) => message.type === 'assistant'), true);
      assert.equal(
        subagentGroup.messages.some((message) => message.type === 'tool_result' || message.type === 'tool_activity'),
        true,
      );

      const subagentGroups = await getJson(
        server.port,
        `/api/subagent-groups/${projects[0].dirName}/${encodeURIComponent(sessions[0].sessionId)}?tail=4&fresh=1`,
      );
      assert.equal(subagentGroups.total, 1);
      assert.equal(subagentGroups.groups[0].subagent.rawSessionId, 'child-session');
      assert.equal(subagentGroups.groups[0].messages.length <= 4, true);
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('dedupes Codex commentary, status, and deferred tool activity messages', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-codex-message-dedupe-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';
    const sessionFile = path.join(codexSessionsDir, '2026', '04', '17', 'dedupe.jsonl');

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    await writeJsonl(sessionFile, [
      {
        timestamp: '2026-04-17T08:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'dedupe-session',
          cwd: projectPath,
          timestamp: '2026-04-17T08:00:00.000Z',
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-17T08:00:00.100Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          model_context_window: 258400,
        },
      },
      {
        timestamp: '2026-04-17T08:00:00.200Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Please inspect and patch the file.',
        },
      },
      {
        timestamp: '2026-04-17T08:00:00.300Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          phase: 'commentary',
          message: 'Inspecting the file first.',
        },
      },
      {
        timestamp: '2026-04-17T08:00:00.400Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Inspecting the file first.' }],
        },
      },
      {
        timestamp: '2026-04-17T08:00:00.500Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
          call_id: 'call-exec',
        },
      },
      {
        timestamp: '2026-04-17T08:00:00.550Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-exec',
          output: 'Chunk ID: abc123\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n/tmp/project\n',
        },
      },
      {
        timestamp: '2026-04-17T08:00:00.600Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'call-exec',
          command: ['pwd'],
          parsed_cmd: [{ type: 'unknown', cmd: 'pwd' }],
          aggregated_output: '/tmp/project\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        timestamp: '2026-04-17T08:00:00.700Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 2048,
              cached_input_tokens: 1024,
              output_tokens: 128,
              total_tokens: 2176,
            },
          },
        },
      },
      {
        timestamp: '2026-04-17T08:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'call-patch',
          input: 'apply_patch\n*** Begin Patch\n*** Update File: foo.txt\n@@\n-old\n+new\n*** End Patch\n',
        },
      },
      {
        timestamp: '2026-04-17T08:00:03.050Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-patch',
          output: '{"output":"Success. Updated the following files:\\nM foo.txt\\n"}',
        },
      },
      {
        timestamp: '2026-04-17T08:00:03.100Z',
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'call-patch',
          success: true,
          stdout: 'Success. Updated the following files:\nM foo.txt\n',
          stderr: '',
          changes: {
            'foo.txt': {
              type: 'update',
              unified_diff: '@@\n-old\n+new\n',
            },
          },
        },
      },
      {
        timestamp: '2026-04-17T08:00:03.150Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 2048,
              cached_input_tokens: 1024,
              output_tokens: 128,
              total_tokens: 2176,
            },
          },
        },
      },
      {
        timestamp: '2026-04-17T08:00:03.300Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      },
    ]);

    await setMtime(sessionFile, '2026-04-17T08:00:03.300Z');

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      const payload = await getJson(
        server.port,
        `/api/messages/${projects[0].dirName}/${encodeURIComponent(sessions[0].sessionId)}?offset=0&limit=50&direction=oldest&fresh=1`,
      );

      const duplicateAssistants = payload.messages.filter(
        (message) => message.type === 'assistant'
          && message.content?.[0]?.text === 'Inspecting the file first.',
      );
      assert.equal(duplicateAssistants.length, 1);
      assert.equal(duplicateAssistants[0].roleLabel, 'CODEX');

      const duplicateStatuses = payload.messages.filter(
        (message) => message.type === 'status'
          && message.content === 'Context 2176/258400 · Input 2048 · Cached 1024 · Output 128',
      );
      assert.equal(duplicateStatuses.length, 1);

      const execActivities = payload.messages.filter((message) => message.type === 'tool_activity' && message.callId === 'call-exec');
      assert.equal(execActivities.length, 1);
      assert.equal(execActivities[0].command, 'pwd');
      assert.equal(execActivities[0].exitCode, 0);
      assert.equal(execActivities[0].output, '/tmp/project\n');

      const patchActivities = payload.messages.filter((message) => message.type === 'tool_activity' && message.callId === 'call-patch');
      assert.equal(patchActivities.length, 1);
      assert.equal(Array.isArray(patchActivities[0].changes), true);
      assert.equal(patchActivities[0].changes.length, 1);
      assert.match(patchActivities[0].diffSource, /\*\*\* Begin Patch/);
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('preserves Claude tool metadata in parsed message payloads', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-claude-tools-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectDir = path.join(claudeProjectsDir, 'tmp-project');

    await mkdirp(projectDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    await writeJsonl(path.join(projectDir, 'real-session.jsonl'), [
      {
        type: 'user',
        message: { content: [{ type: 'text', text: 'run the command' }] },
        gitBranch: 'main',
        timestamp: '2026-04-11T00:00:00.000Z',
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: {
                command: 'echo hi',
                description: 'Say hi',
              },
            },
          ],
        },
        timestamp: '2026-04-11T00:00:01.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'hi',
              is_error: false,
            },
          ],
        },
        toolUseResult: {
          stdout: 'hi',
          stderr: '',
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
        timestamp: '2026-04-11T00:00:02.000Z',
      },
    ]);

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      const payload = await getJson(
        server.port,
        `/api/messages/${projects[0].dirName}/${encodeURIComponent(sessions[0].sessionId)}?offset=0&limit=50&direction=newest`,
      );
      const assistant = payload.messages.find((message) => message.type === 'assistant');
      const toolResult = payload.messages.find((message) => message.type === 'tool_result');

      assert.equal(assistant.content[0].type, 'tool_use');
      assert.equal(assistant.content[0].summary, 'echo hi');
      assert.equal(assistant.content[0].input.command, 'echo hi');

      assert.equal(toolResult.content[0].type, 'tool_result');
      assert.equal(toolResult.content[0].summary, 'stdout=hi · stderr= · interrupted=false');
      assert.equal(toolResult.content[0].structured.stdout, 'hi');
      assert.equal(toolResult.content[0].isError, false);
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('rescans legacy cached Codex metadata before deciding whether a session is visible', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-codex-legacy-cache-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    const parentFile = path.join(codexSessionsDir, '2026', '04', '16', 'parent.jsonl');
    const childFile = path.join(codexSessionsDir, '2026', '04', '16', 'child.jsonl');

    await writeJsonl(parentFile, [
      {
        timestamp: '2026-04-16T09:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'parent-session',
          cwd: projectPath,
          timestamp: '2026-04-16T09:00:00.000Z',
          model: 'gpt-5.4',
          source: 'cli',
        },
      },
      {
        timestamp: '2026-04-16T09:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'parent prompt',
        },
      },
    ]);

    await writeJsonl(childFile, [
      {
        timestamp: '2026-04-16T09:01:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'child-session',
          cwd: projectPath,
          timestamp: '2026-04-16T09:01:00.000Z',
          model: 'gpt-5.4',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'parent-session',
                depth: 1,
                agent_role: 'explorer',
                agent_nickname: 'Kierkegaard',
              },
            },
          },
        },
      },
      {
        timestamp: '2026-04-16T09:01:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'child prompt',
        },
      },
    ]);

    await setMtime(parentFile, '2026-04-16T09:00:01.000Z');
    await setMtime(childFile, '2026-04-16T09:01:01.000Z');

    const childStat = await fs.stat(childFile);
    const childCacheKey = `codex:${childFile}`;
    const childFingerprint = `${Math.floor(childStat.mtimeMs)}:${childStat.size}`;

    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(
      CACHE_FILE,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        entries: {
          [childCacheKey]: {
            fingerprint: childFingerprint,
            data: {
              source: 'codex',
              projectPath,
              rawSessionId: 'child-session',
              firstPrompt: 'child prompt',
              messageCount: 1,
              created: '2026-04-16T09:01:00.000Z',
              modified: '2026-04-16T09:01:01.000Z',
              gitBranch: '',
              model: 'gpt-5.4',
              fileSizeBytes: childStat.size,
            },
          },
        },
      }, null, 2) + '\n',
      'utf8',
    );

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      assert.equal(projects.length, 1);

      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.deepEqual(
        sessions.map((session) => session.rawSessionId),
        ['parent-session'],
      );
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('rescans cached hidden Codex subagent metadata to recover terminal status', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-codex-subagent-cache-refresh-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    const parentFile = path.join(codexSessionsDir, '2026', '04', '17', 'parent.jsonl');
    const childFile = path.join(codexSessionsDir, '2026', '04', '17', 'child.jsonl');

    await writeJsonl(parentFile, [
      {
        timestamp: '2026-04-17T09:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'parent-session',
          cwd: projectPath,
          timestamp: '2026-04-17T09:00:00.000Z',
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-17T09:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'parent prompt',
        },
      },
    ]);

    await writeJsonl(childFile, [
      {
        timestamp: '2026-04-17T09:01:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'child-session',
          cwd: projectPath,
          timestamp: '2026-04-17T09:01:00.000Z',
          model: 'gpt-5.4',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'parent-session',
                depth: 1,
                agent_role: 'explorer',
                agent_nickname: 'Aristotle',
              },
            },
          },
          agent_role: 'explorer',
          agent_nickname: 'Aristotle',
        },
      },
      {
        timestamp: '2026-04-17T09:01:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'child prompt',
        },
      },
      {
        timestamp: '2026-04-17T09:01:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          completed_at: 1776416465,
          duration_ms: 4000,
        },
      },
    ]);

    await setMtime(parentFile, '2026-04-17T09:00:01.000Z');
    await setMtime(childFile, '2026-04-17T09:01:05.000Z');

    const childStat = await fs.stat(childFile);
    const childCacheKey = `codex:${childFile}`;
    const childFingerprint = `${Math.floor(childStat.mtimeMs)}:${childStat.size}`;

    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(
      CACHE_FILE,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        entries: {
          [childCacheKey]: {
            fingerprint: childFingerprint,
            data: {
              source: 'codex',
              projectPath,
              rawSessionId: 'child-session',
              relativePath: path.relative(codexSessionsDir, childFile),
              isSubagentSession: true,
              parentThreadId: 'parent-session',
              agentRole: 'explorer',
              agentNickname: 'Aristotle',
              depth: 1,
              firstPrompt: 'child prompt',
              messageCount: 1,
              created: '2026-04-17T09:01:00.000Z',
              modified: '2026-04-17T09:01:05.000Z',
              gitBranch: '',
              model: 'gpt-5.4',
              fileSizeBytes: childStat.size,
            },
          },
        },
      }, null, 2) + '\n',
      'utf8',
    );

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      assert.equal(projects.length, 1);

      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.deepEqual(
        sessions.map((session) => session.rawSessionId),
        ['parent-session'],
      );

      const groups = await getJson(
        server.port,
        `/api/subagent-groups/${projects[0].dirName}/${encodeURIComponent(sessions[0].sessionId)}?tail=4&fresh=1`,
      );
      assert.equal(groups.total, 1);
      assert.equal(groups.groups[0].subagent.status, 'completed');
      assert.equal(groups.groups[0].subagent.durationMs, 4000);
      assert.match(groups.groups[0].subagent.completedAt, /^2026-04-17T09:01:05/);
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});


test('extracts Codex file size and context usage metadata', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-codex-metrics-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    const sessionFile = path.join(codexSessionsDir, '2026', '04', '16', 'metrics.jsonl');
    await writeJsonl(sessionFile, [
      {
        timestamp: '2026-04-16T01:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'metrics-session',
          cwd: projectPath,
          timestamp: '2026-04-16T01:00:00.000Z',
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-16T01:00:00.100Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
          model_context_window: 258400,
        },
      },
      {
        timestamp: '2026-04-16T01:00:00.200Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 42000,
              cached_input_tokens: 12000,
              output_tokens: 1800,
              total_tokens: 43800,
            },
            last_token_usage: {
              input_tokens: 8000,
              cached_input_tokens: 2500,
              output_tokens: 600,
              total_tokens: 8600,
            },
            model_context_window: 258400,
          },
        },
      },
      {
        timestamp: '2026-04-16T01:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'metrics prompt',
        },
      },
    ]);

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      assert.equal(projects.length, 1);
      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].fileSizeBytes > 0, true);
      assert.equal(sessions[0].contextWindowTokens, 258400);
      assert.equal(sessions[0].lastUsedTokens, 8600);
      assert.equal(sessions[0].totalInputTokens, 42000);
      assert.equal(sessions[0].totalOutputTokens, 1800);
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('serves newest Codex messages for large sessions', async () => {
  await withPreservedCache(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-dashboard-codex-recent-'));
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const copilotSessionStateDir = path.join(root, 'copilot');
    const projectPath = '/tmp/project';

    await mkdirp(claudeProjectsDir);
    await mkdirp(codexSessionsDir);
    await mkdirp(copilotSessionStateDir);

    const sessionFile = path.join(codexSessionsDir, '2026', '04', '16', 'recent.jsonl');
    const filler = 'x'.repeat(5000);
    const lines = [
      {
        timestamp: '2026-04-16T02:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'recent-session',
          cwd: projectPath,
          timestamp: '2026-04-16T02:00:00.000Z',
          model: 'gpt-5.4',
        },
      },
    ];

    for (let index = 0; index < 600; index += 1) {
      lines.push({
        timestamp: `2026-04-16T02:00:${String(index % 60).padStart(2, '0')}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `chunk-${index}-${filler}`,
        },
      });
    }

    lines.push({
      timestamp: '2026-04-16T02:59:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'tail-user-message',
      },
    });
    lines.push({
      timestamp: '2026-04-16T02:59:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'tail-assistant-message' }],
      },
    });

    await writeJsonl(sessionFile, lines);

    const server = await startServer({ claudeProjectsDir, codexSessionsDir, copilotSessionStateDir });
    try {
      const projects = await getJson(server.port, '/api/projects');
      assert.equal(projects.length, 1);
      const sessions = await getJson(server.port, `/api/sessions/${projects[0].dirName}`);
      assert.equal(sessions.length, 1);

      const response = await fetch(`http://127.0.0.1:${server.port}/api/messages/${projects[0].dirName}/${encodeURIComponent(sessions[0].sessionId)}?offset=0&limit=2&direction=newest`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(Array.isArray(payload.messages), true);
      assert.equal(typeof payload.total, 'number');
      assert.equal(payload.messages.length, 2);
      assert.equal(payload.messages[0].type, 'user');
      assert.equal(payload.messages[0].content, 'tail-user-message');
      assert.equal(payload.messages[1].type, 'assistant');
      assert.equal(payload.messages[1].content[0].text, 'tail-assistant-message');
      assert.equal(payload.total > payload.messages.length, true);
      assert.equal(payload.hasMore, true);
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
