# Configuration Reference

## File-based configuration

Default config file:

```text
./config.json
```

Override with:

```bash
node server.js --config /path/to/config.json
```

Or:

```bash
SESSION_DASHBOARD_CONFIG=/path/to/config.json npm start
```

## Supported keys

- `port`
- `workspaceRoot`
- `claudeProjectsDir`
- `claudeModelsFile`
- `codexSessionsDir`
- `copilotSessionStateDir`
- `codexBin`
- `claudeBin`
- `copilotBin`
- `copilotConfigDir`
- `copilotConfigFile`

## Environment variable overrides

- `SESSION_DASHBOARD_PORT`
- `SESSION_DASHBOARD_WORKSPACE_ROOT`
- `CLAUDE_PROJECTS_DIR`
- `CLAUDE_MODELS_FILE`
- `CODEX_SESSIONS_DIR`
- `COPILOT_SESSION_STATE_DIR`
- `CODEX_BIN`
- `CLAUDE_BIN`
- `COPILOT_BIN`
- `COPILOT_CONFIG_DIR`
- `COPILOT_CONFIG_FILE`
