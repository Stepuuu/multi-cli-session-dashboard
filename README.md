<div align="center">

# CLI Session Dashboard

**A self-hosted dashboard for browsing and continuing local AI CLI sessions**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-blue.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-lightgrey.svg)](package.json)

**Documentation / 文档**

[🇬🇧 English](README_EN.md) · [🇨🇳 中文](README_CN.md)

</div>

---

### Highlights / 亮点

| Feature | Description | 功能 |
|---|---|---|
| Multi-source history | Browse Claude, Codex, and Copilot sessions in one UI | 在一个界面里浏览 Claude / Codex / Copilot 会话 |
| Draft sessions | Start new sessions from a selected project and send the first prompt from the browser | 选中项目后可在浏览器中创建新会话并发送首条消息 |
| Live interaction | Stream status, tool events, and model replies into the chat timeline | 将状态、工具事件、回复实时流式插入聊天记录 |
| Image input | Paste or upload images; use native attachments when available | 支持粘贴/上传图片；可用时走原生图片附件 |
| Workspace tabs | Pin frequently used sessions for one-click switching across projects | 固定常用会话，单窗口跨项目一键切换 |
| Smarter refresh | Lightweight digests and metadata caching reduce unnecessary rescans | 轻量 digest 与元数据缓存减少重复扫描 |
| No framework lock-in | Plain Node.js + vanilla frontend, easy to fork and adapt | 纯 Node.js + 原生前端，易于二次开发 |

### Quick Start / 快速开始

```bash
cp config.example.json config.json
# edit the paths for your local CLI histories

npm start
# open http://localhost:3456
```

See full setup: [English](README_EN.md) · [中文](README_CN.md)

---

### Contributing / 贡献

Issues, feature requests, and pull requests are welcome.
If you want to improve the dashboard, add support for another CLI, or refine the interaction experience, please open an issue or submit a pull request:

- Issues: <https://github.com/Stepuuu/multi-cli-session-dashboard/issues>
- Pull Requests: <https://github.com/Stepuuu/multi-cli-session-dashboard/pulls>

欢迎提交 Issue、功能建议和 Pull Request。
如果你想改进这个 dashboard、支持新的 CLI 工具，或优化交互体验，可以直接提交 issue 或 PR：

- Issues: <https://github.com/Stepuuu/multi-cli-session-dashboard/issues>
- Pull Requests: <https://github.com/Stepuuu/multi-cli-session-dashboard/pulls>

---

### Citation / 引用

If this project helps your workflow, research, or tool-building, please cite it:

如果本项目对你的工作流、研究或工具开发有帮助，欢迎引用：

```bibtex
@misc{multi-cli-session-dashboard,
  author       = {Stepuuu},
  title        = {CLI Session Dashboard: A Self-hosted Dashboard for Browsing and Continuing Local AI CLI Sessions},
  year         = {2026},
  publisher    = {GitHub},
  howpublished = {\url{https://github.com/Stepuuu/multi-cli-session-dashboard}},
}
```

---

<div align="center">
  <b>One dashboard for your local AI CLI sessions · 一个面板管理多种本地 AI CLI 会话</b><br>
  <a href="https://github.com/Stepuuu/multi-cli-session-dashboard">GitHub</a> · MIT License
</div>
