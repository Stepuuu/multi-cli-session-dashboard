# CLI Session Dashboard

一个自托管的网页面板，用来统一浏览并继续本地 AI CLI 工具的会话历史，例如 Claude Code、Codex CLI、GitHub Copilot CLI。

## 这个项目解决什么问题

如果你同时使用多个终端 AI 工具，会很快遇到几个问题：

- 会话历史分散在不同隐藏目录里
- 每家的落盘格式都不一样
- 过一段时间很难回看某条会话到底属于哪个项目
- SSH 到远程机器时，很难像本地 App 一样方便地贴图

这个项目提供了一层统一的浏览和交互界面：

- 按项目浏览多来源会话
- 在网页里查看历史聊天
- 继续已有会话
- 从浏览器发送文字和图片

## 功能特性

- 同时浏览以下工具的本地会话历史：
  - Claude Code
  - Codex CLI
  - GitHub Copilot CLI
- 按工作区 / 项目路径聚合会话
- 在项目列表和会话列表里显示来源标记
- 把原始 JSONL 文本整理成更接近 CLI 的显示效果
- 对跨天 resume 的会话增加日期分隔，减少“时间乱跳”的错觉
- 在浏览器里继续已有 session
- 在选中项目后创建新的 draft session
- 把状态、工具事件、回复流式插入聊天记录
- 支持粘贴/上传图片

## 架构

这个项目刻意保持简单：

- 后端：纯 Node.js HTTP 服务
- 前端：静态 HTML + CSS + 原生 JS
- 数据源：直接读取各工具本地的持久化目录

后端把三种完全不同的历史格式统一成一个内部消息模型：

- Claude Code: `~/.claude/projects`
- Codex CLI: `~/.codex/sessions`
- Copilot CLI: `~/.copilot/session-state`

## 目录结构

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

## 运行要求

- Node.js 18+
- 至少安装一种支持的 CLI 工具
- 对应工具启用了本地 session 持久化

推荐：

- `claude` 在 PATH 中
- `codex` 在 PATH 中
- `copilot` 在 PATH 中

## 配置

先复制模板：

```bash
cp config.example.json config.json
```

再按你的机器修改：

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

也支持通过：

- 环境变量
- CLI 参数，比如 `--port`、`--config`、`--claude-projects-dir`

来覆盖配置。

## 启动

```bash
npm start
```

然后打开：

```text
http://localhost:3456
```

## 交互语义

网页右侧的输入框不是“新开一个匿名聊天框”，而是**继续当前选中的真实 session**。

这意味着：

- 如果你选中的会话本身上下文很重，工具会沿着原会话继续
- 这是设计行为，不是 bug
- 如果你想更干净地开始，就用项目下方的新建 draft session 按钮

## 图片处理方式

不同工具的图片支持不完全一样：

- Codex CLI：走原生图片附件
- Claude Code：先把图片保存到本地，再把文件路径写进 prompt
- Copilot CLI：同样先落本地，再把路径写进 prompt

这样即使你是通过 SSH 在远端跑工具，也能从浏览器侧方便地贴图。

## 安全说明

- 这个项目会直接读取本地会话历史
- 也能把新消息发回本地 CLI session
- 如果不加鉴权，请不要直接暴露到公网
- 使用前请确认本地 CLI 的权限模式符合你的预期

## 适合继续扩展的方向

- 增加登录鉴权
- 支持更多 CLI / Agent 工具
- 更好的工具事件卡片
- 会话全文检索
- 导出和归档功能

## 开源许可

MIT
