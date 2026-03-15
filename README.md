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
| No framework lock-in | Plain Node.js + vanilla frontend, easy to fork and adapt | 纯 Node.js + 原生前端，易于二次开发 |

### Quick Start / 快速开始

```bash
cp config.example.json config.json
# edit the paths for your local CLI histories

npm start
# open http://localhost:3456
```

See full setup: [English](README_EN.md) · [中文](README_CN.md)
