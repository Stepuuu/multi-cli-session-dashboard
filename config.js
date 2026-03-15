import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function loadConfigFile(configPath) {
  if (!configPath || !existsSync(configPath)) return {};
  const parsed = safeJsonParse(readFileSync(configPath, 'utf-8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

export function loadRuntimeConfig(argv = process.argv.slice(2)) {
  const home = os.homedir();
  const defaultConfigPath = process.env.SESSION_DASHBOARD_CONFIG || path.join(__dirname, 'config.json');
  const fileConfig = loadConfigFile(defaultConfigPath);

  const config = {
    port: 3456,
    workspaceRoot: process.cwd(),
    claudeProjectsDir: path.join(home, '.claude', 'projects'),
    codexSessionsDir: path.join(home, '.codex', 'sessions'),
    copilotSessionStateDir: path.join(home, '.copilot', 'session-state'),
    codexBin: 'codex',
    claudeBin: 'claude',
    copilotBin: 'copilot',
    copilotConfigDir: path.join(home, '.copilot'),
    copilotConfigFile: path.join(home, '.copilot', 'config.json'),
    configPath: defaultConfigPath,
    ...fileConfig,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      const inlineConfig = loadConfigFile(argv[++i]);
      Object.assign(config, inlineConfig, { configPath: argv[i] });
    } else if ((argv[i] === '--projects-dir' || argv[i] === '--claude-projects-dir') && argv[i + 1]) {
      config.claudeProjectsDir = argv[++i];
    } else if (argv[i] === '--codex-sessions-dir' && argv[i + 1]) {
      config.codexSessionsDir = argv[++i];
    } else if (argv[i] === '--copilot-session-state-dir' && argv[i + 1]) {
      config.copilotSessionStateDir = argv[++i];
    } else if (argv[i] === '--workspace-root' && argv[i + 1]) {
      config.workspaceRoot = argv[++i];
    } else if (argv[i] === '--codex-bin' && argv[i + 1]) {
      config.codexBin = argv[++i];
    } else if (argv[i] === '--claude-bin' && argv[i + 1]) {
      config.claudeBin = argv[++i];
    } else if (argv[i] === '--copilot-bin' && argv[i + 1]) {
      config.copilotBin = argv[++i];
    } else if (argv[i] === '--copilot-config-dir' && argv[i + 1]) {
      config.copilotConfigDir = argv[++i];
    } else if (argv[i] === '--copilot-config-file' && argv[i + 1]) {
      config.copilotConfigFile = argv[++i];
    } else if (argv[i] === '--port' && argv[i + 1]) {
      config.port = parseInt(argv[++i], 10);
    }
  }

  const envMap = {
    SESSION_DASHBOARD_PORT: 'port',
    SESSION_DASHBOARD_WORKSPACE_ROOT: 'workspaceRoot',
    CLAUDE_PROJECTS_DIR: 'claudeProjectsDir',
    CODEX_SESSIONS_DIR: 'codexSessionsDir',
    COPILOT_SESSION_STATE_DIR: 'copilotSessionStateDir',
    CODEX_BIN: 'codexBin',
    CLAUDE_BIN: 'claudeBin',
    COPILOT_BIN: 'copilotBin',
    COPILOT_CONFIG_DIR: 'copilotConfigDir',
    COPILOT_CONFIG_FILE: 'copilotConfigFile',
  };

  for (const [envKey, configKey] of Object.entries(envMap)) {
    if (process.env[envKey]) {
      config[configKey] = envKey === 'SESSION_DASHBOARD_PORT'
        ? parseInt(process.env[envKey], 10)
        : process.env[envKey];
    }
  }

  return config;
}
