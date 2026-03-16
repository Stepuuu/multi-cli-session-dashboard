# CLI Session Dashboard

A self-hosted web dashboard for browsing and continuing local sessions from AI coding CLIs such as Claude Code, Codex CLI, and GitHub Copilot CLI.

## Why this project exists

If you use multiple terminal-based AI tools, session history quickly fragments across different hidden folders and storage formats. This project gives you:

- a unified project-level session browser
- a single chat view for old sessions
- the ability to continue an existing session from the browser
- lightweight support for image input when your SSH / terminal workflow makes pasting images awkward

This repository is the generalized open-source version of a production internal dashboard. Personal paths, personal data, and machine-specific assumptions have been removed and replaced with configuration.

## Features

- Browse local session histories from:
  - Claude Code
  - Codex CLI
  - GitHub Copilot CLI
- Group sessions by workspace / project path
- Show source badges in both project and session lists
- Render markdown-like assistant output more cleanly than raw JSONL
- Clarify cross-day resumed sessions with date separators
- Continue existing sessions from the browser
- Create new draft sessions from a selected project
- Stream live status, tool events, and assistant output into the chat timeline
- Paste or upload images from the browser

## Architecture

This project intentionally stays simple:

- Backend: plain Node.js HTTP server
- Frontend: static HTML + CSS + vanilla JS
- Session storage: read directly from each tool's local persistence directory

The backend normalizes three different storage formats into one internal model:

- Claude Code: `~/.claude/projects`
- Codex CLI: `~/.codex/sessions`
- Copilot CLI: `~/.copilot/session-state`

## Project Structure

```text
multi-cli-session-dashboard/
├── config.example.json
├── config.js
├── interaction.js
├── server.js
├── public/
│   ├── index.html
│   ├── css/
│   └── js/
└── README*.md
```

## Requirements

- Node.js 18+
- At least one supported CLI installed locally
- Local session persistence enabled for the tools you want to browse

Optional but recommended:

- `claude` in `PATH`
- `codex` in `PATH`
- `copilot` in `PATH`

## Configuration

Copy the example file:

```bash
cp config.example.json config.json
```

Then edit the paths:

```json
{
  "port": 3456,
  "workspaceRoot": "/path/to/your/workspace",
  "claudeProjectsDir": "/home/your-user/.claude/projects",
  "codexSessionsDir": "/home/your-user/.codex/sessions",
  "copilotSessionStateDir": "/home/your-user/.copilot/session-state",
  "codexBin": "codex",
  "claudeBin": "claude",
  "copilotBin": "copilot"
}
```

You can also override settings via:

- environment variables
- CLI flags such as `--port`, `--config`, `--claude-projects-dir`

## Run

```bash
npm start
```

Open:

```text
http://localhost:3456
```

## Interaction behavior

The browser composer does not open a generic chat sandbox. It continues the selected tool session.

That means:

- if you select an old session with heavy context, the tool may continue that exact context
- this is by design
- new draft sessions are provided when you want a cleaner starting point

## Image handling

Image support differs by tool:

- Codex CLI: native image attachment
- Claude Code: image is saved locally and referenced in the prompt
- Copilot CLI: image is saved locally and referenced in the prompt

This makes browser-side image input practical even when the real tool is running over SSH.

## Security notes

- This project reads local session history files directly
- It can send prompts back into local CLI sessions
- Do not expose it publicly without authentication and network controls
- Review your local CLI permissions before using browser-side interaction

## Suggested open-source roadmap

- Add authentication
- Add configurable source adapters
- Add MCP / tool inspection cards
- Add export / archive support
- Add search across sessions

## Contributing

Issues, feature requests, and pull requests are welcome.

If you want to improve the dashboard, support another CLI, or refine the browser-side interaction workflow, please open an issue or submit a PR:

- Issues: <https://github.com/Stepuuu/multi-cli-session-dashboard/issues>
- Pull Requests: <https://github.com/Stepuuu/multi-cli-session-dashboard/pulls>

Suggested contribution areas:

- support for additional AI CLIs
- authentication and multi-user deployment
- search and indexing improvements
- richer rendering for tool events and artifacts
- better export / archive workflows

## Citation

If this project helps your workflow, research, or internal tooling, please cite it:

```bibtex
@misc{multi-cli-session-dashboard,
  author       = {Stepuuu},
  title        = {CLI Session Dashboard: A Self-hosted Dashboard for Browsing and Continuing Local AI CLI Sessions},
  year         = {2026},
  publisher    = {GitHub},
  howpublished = {\url{https://github.com/Stepuuu/multi-cli-session-dashboard}},
}
```

## License

MIT
