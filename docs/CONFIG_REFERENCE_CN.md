# 配置参考

## 文件配置

默认配置文件：

```text
./config.json
```

可通过以下方式覆盖：

```bash
node server.js --config /path/to/config.json
```

或者：

```bash
SESSION_DASHBOARD_CONFIG=/path/to/config.json npm start
```

## 支持的配置键

- `port`
- `workspaceRoot`
- `claudeProjectsDir`
- `codexSessionsDir`
- `copilotSessionStateDir`
- `codexBin`
- `claudeBin`
- `copilotBin`
- `copilotConfigDir`
- `copilotConfigFile`

## 可覆盖的环境变量

- `SESSION_DASHBOARD_PORT`
- `SESSION_DASHBOARD_WORKSPACE_ROOT`
- `CLAUDE_PROJECTS_DIR`
- `CODEX_SESSIONS_DIR`
- `COPILOT_SESSION_STATE_DIR`
- `CODEX_BIN`
- `CLAUDE_BIN`
- `COPILOT_BIN`
- `COPILOT_CONFIG_DIR`
- `COPILOT_CONFIG_FILE`
