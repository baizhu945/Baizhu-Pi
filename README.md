# Baizhu Pi

这是一个由 Home Manager 声明式部署的 Pi coding agent 配置：默认使用大上下文模型，任务可用持久化 Todo 和隔离子代理拆分。Pi 本体固定跟随 nixpkgs，只有仍需要的命令超时行为通过 overlay 补丁维护。

该模块还导入 `../cc-connect.nix`，因此同一代 Home Manager 配置会安装并启用 `cc-connect` 用户服务。

## 默认行为

`pi.nix` 通过 nixpkgs overlay 给 `pi-coding-agent` 应用本目录的补丁，并声明配置文件、扩展、agents、skills 和运行时依赖。当前实际设置为：

| 项目 | 配置 |
| --- | --- |
| 默认模型 | `openai/gpt-5.6-luna` |
| 思考级别 | `xhigh`；thinking block 默认展开 |
| 重试 | 开启，最多 5 次 |
| 项目可信度 | `defaultProjectTrust = "ask"` |
| 上下文覆盖 | `gpt-5.6-luna/terra/sol` 在 `openai` 与 `openai-codex` 下均为 1,050,000 |
| 子代理限制 | 无扩展层 turn-count 限制；仅受 provider、上下文窗口及外部停止影响 |

思考显示可用 `Ctrl+T` 或 `Alt+T` 切换。`models.json` 是为了覆盖模型目录中的上下文窗口；`pi.nix` 中默认模型附近的注释曾有过时表述，运行行为以 `settings.defaultModel` 为准。

## 权限说明

本配置不部署自定义 `permission-gate.ts`；工具权限遵循 Pi 本身、运行环境及各扩展的既有策略。不要在 Home Manager 激活时重新添加该文件。

## 子代理编排与可视化

`extensions/pi-subagents/` 是由 Home Manager 声明式部署的本地 fork，入口为 `index.ts`。它保留原插件的 agent 类型、worktree、workflow、调度、FleetView、transcript 等能力，但顶层 `Agent` 只有后台模式：调用立即返回 ID，子代理完成后将最终 assistant 总结作为 OpenCode 风格的 `task_result` 自动通知插入主会话；`.output` JSONL 仅保留给 UI/调试，不会暴露给主模型；不再注册 `get_subagent_result`。

内置 `Explore` 不固定 Haiku，而是继承主会话模型；`pi.nix` 的 activation 会清理旧 npm 副本，避免已编译的旧 Haiku pin 再次被发现。

## Todo：分支正确的任务状态

`extensions/todo.ts` 把 Todo 状态写入 session entries，而不是只放在进程内存中，所以 `/fork` 或恢复历史后，列表会对应当前分支。它提供 `pending`、`in_progress`、`completed`、`cancelled` 四种状态，并强制同一时间最多一个 `in_progress` 项。

模型会收到“3 个以上步骤主动使用 Todo”的 prompt guidance；用户可用 `/todos` 在 TUI 中查看完整列表。Todo 状态从同一批 session entries 重建，因此不会和当前会话分支脱节。

## TUI 与复制体验

Pi 0.84.4 已原生提供全屏模式的鼠标选择、滚轮、双击单词选择和复制控制；普通模式继续交给终端处理原生文本选择。配置中的 `extensions/sidebar.ts` 保留为兼容 0.84.4 公共 API 的底栏扩展，显示 token、美元成本、上下文、模型、分支、状态和 Todo 摘要。启动界面额外通过 `startup-logo.patch` 显示居中的大号 Pi logo。

## 成本、命令执行与补丁

- `startup-logo.patch` 在启动界面显示放大的 Pi logo，同时保留版本号和可展开的启动帮助。

右侧栏相关补丁、人民币换算扩展和复制换行补丁已移除；这些功能要么已由 0.84.4 上游实现，要么依赖已经删除的私有 TUI API。

## 网络与浏览器数据边界

`pi.nix` 安装 `pi-web-access`，并写入 `~/.pi/agent/web-search.json`：

- 仅额外允许本机 Clash/Mihomo fake-IP 使用的 `198.18.0.0/15`，不会因此放行 localhost、私网或字面 IP；
- `allowBrowserCookies = false` 默认关闭；只有明确需要 Gemini Web 的 Chromium cookie 提取时才应手动打开。

这使公网抓取能适配当前代理的 fake-IP DNS，同时保留包自身的 SSRF 预检。

## 技能与文件落点

Home Manager 将配置写入以下位置：

```text
~/.pi/agent/AGENTS.md             # agent-context.md
~/.pi/agent/extensions/           # 侧栏、Todo、子代理等扩展
~/.pi/agent/agents/               # general.md、explore.md
~/.pi/agent/skills/               # 本地与外部技能
~/.pi/agent/models.json
~/.pi/agent/keybindings.json
~/.pi/agent/web-search.json
```

技能来源包括本地 `agent/skills`、Anthropic 的 docx/pptx/xlsx/pdf/canvas-design、`media-processor` 和 `idea-refine`。`superpowers` 在此配置中目前未启用（对应注释保留在 `pi.nix`）。

## 维护提示

修改 `pi.nix` 的 overlay patch、Pi 版本或扩展 API 后，应优先检查：补丁是否无 fuzz 应用、扩展是否只使用当前版本的公共 API、子代理的进程组终止是否仍能清理孙进程，以及模型目录是否继续提供 1,050,000 上下文。

`skills.nix` 的外部技能已经固定 revision 和 hash；更新时应同时重新验证内容与 hash。扩展源码由 Home Manager 以声明式文件方式部署，不建议直接修改 `~/.pi/agent/` 下的生成文件。
