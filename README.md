# Baizhu Pi

这是一个由 Home Manager 声明式部署的 Pi coding agent 配置，重点不是“把 TUI 换个颜色”，而是把 Pi 变成一个可控、可审计、适合长时间编码任务的本地 Agent：默认大上下文模型，所有高风险工具经过权限闸门，任务可用持久化 Todo 和隔离子代理拆分，终端界面则提供固定状态栏、成本统计和可复制的对话视图。

该模块还导入 `../cc-connect.nix`，因此同一代 Home Manager 配置会安装并启用 `cc-connect` 用户服务；Pi 的 `CC_PERMISSION_MODE=yolo` 分支正是为这类自动化运行保留的明确入口。

## 默认行为

`pi.nix` 通过 nixpkgs overlay 给 `pi-coding-agent` 应用本目录的补丁，并声明配置文件、扩展、agents、skills 和运行时依赖。当前实际设置为：

| 项目 | 配置 |
| --- | --- |
| 默认模型 | `openai/gpt-5.6-luna` |
| 思考级别 | `xhigh`；thinking block 默认展开 |
| 重试 | 开启，最多 5 次 |
| 项目可信度 | `defaultProjectTrust = "ask"` |
| 上下文覆盖 | `gpt-5.6-luna/terra/sol` 在 `openai` 与 `openai-codex` 下均为 1,050,000 |
| 子代理上限 | 默认 30 分钟；终止后等待 3 秒再强制杀进程组 |

思考显示可用 `Ctrl+T` 或 `Alt+T` 切换。`models.json` 是为了覆盖模型目录中的上下文窗口；`pi.nix` 中默认模型附近的注释曾有过时表述，运行行为以 `settings.defaultModel` 为准。

## 最重要的特色：权限闸门

`extensions/permission-gate.ts` 采用“安全白名单，其余默认询问”的策略：

- 直接放行本地只读：`read`、`grep`、`ls`、`find`；
- 直接放行调度/状态：`subagent`、`todo`；
- 直接放行网络只读和交互：`web_search`、`fetch_content`、`get_search_content`、`source_check`、`ask_user`；
- `bash`、`write`、`edit` 以及任何未知/新增工具都必须询问；
- 交互式对话框提供 **Yes / No / Always allow**，`Always allow` 只持续到当前会话切换；
- 没有 UI 的非交互运行会直接拦截需要询问的工具，而不是静默放行。

`CC_PERMISSION_MODE=yolo` 是给 `cc-connect` 自动任务使用的明确例外：该环境变量为 `yolo` 时跳过闸门。除此之外，新增工具默认落入“需要询问”的一侧，降低扩展升级后意外获得写入/执行权限的风险。

## 子代理编排与可视化

`extensions/subagent/` 把一次子代理调用启动为独立的 Pi 进程（JSON 模式、无 session 文件），只把结构化结果回传主会话，并且禁止子代理递归创建更多子代理。

支持三种模式：

| 模式 | 用途 |
| --- | --- |
| single | 将一个明确任务交给 `general` 或 `explore` 等 agent。 |
| parallel | 同时处理独立任务，最多 8 项，最多 4 个并发进程。 |
| chain | 顺序执行多个 agent，下一步任务可用 `{previous}` 接收上一步最终输出。 |

agent 从 `~/.pi/agent/agents/*.md` 读取；也可按 `agentScope` 使用当前项目最近的 `.pi/agents`。执行项目 agent 时默认再次确认，因为它们由仓库控制；同名项目 agent 会覆盖用户 agent。内置配置中：

- `explore`：只读的快速代码库搜索/定位 agent；
- `general`：可执行多步骤研究和任务的通用 agent。

每个子代理都有硬超时，超时或取消时先对整个进程组发送 SIGTERM，宽限后发送 SIGKILL，并回收残留管道；单项输出还有限制，避免子代理拖垮主会话。

完整运行记录保存在主会话 tool result 中。`Alt+S` 或 `/subagents` 打开全屏查看器，可循环浏览每个子代理的任务、思考、工具调用、结果、模型和用量；`Esc`/`q` 退出，方向键和 PgUp/PgDn 滚动。

## Todo：分支正确的任务状态

`extensions/todo.ts` 把 Todo 状态写入 session entries，而不是只放在进程内存中，所以 `/fork` 或恢复历史后，列表会对应当前分支。它提供 `pending`、`in_progress`、`completed`、`cancelled` 四种状态，并强制同一时间最多一个 `in_progress` 项。

模型会收到“3 个以上步骤主动使用 Todo”的 prompt guidance；用户可用 `/todos` 在 TUI 中查看完整列表。右侧栏从同一批 session entries 重建 Todo，因此不会和当前会话分支脱节。

## 宽屏右侧状态栏与复制体验

`extensions/sidebar.ts` 配合 `sidebar-layout.patch`、`sidebar-scroll.patch` 提供类似 opencode 的固定右侧栏：终端宽度达到 **120 列**时显示宽度约 **42 列**的面板，聊天区域自动让出空间，浏览历史时右栏仍固定在屏幕上。

面板集中显示：

- 当前模型、思考级别、输入/输出 token、缓存命中率；
- 通过实时 USD→CNY 汇率换算的成本；
- 上下文占用率（超过 70%/90% 使用警告/错误色）；
- Git 分支、扩展状态和可独立滚动的 Todo 列表。

宽屏底栏只显示“状态和 Todo 在右侧栏”的提示；窄屏自动退化为完整底栏，不浪费横向空间。鼠标滚轮在聊天列只滚聊天，在侧栏列只滚 Todo。

`main-screen-selection.patch` 开启主屏 SGR 鼠标跟踪和应用级拖拽选择：普通拖拽只选择聊天列，不把右侧栏一起复制，释放时自动写入终端剪贴板。`unwrap-copy.patch` 为硬换行加不可见边界标记，复制长段落时不会把显示换行错误地变成多余的换行符；终端原生的 Shift+拖拽选择仍由终端处理。

## 成本、命令执行与补丁

- `currency-rate.ts` 会在 session 启动时从 `open.er-api.com` 或 `frankfurter.app` 获取 USD→CNY 汇率，成功后每 6 小时刷新，失败 10 分钟后重试；离线时回退到 7.2。
- `cost-cny.patch` 让 Pi 底栏显示 `¥` 而不是 `$`，读取扩展写入的 `PI_USD_CNY_RATE`。
- `bash-timeout.patch` 让模型未指定超时时使用并显示 120 秒，模型显式传值仍优先。
- `sidebar-layout.patch` 同时增加 extension sidebar/right-reserved-width API、viewport 内部滚动和启动页的大型 logo，保证侧栏扩展不覆盖聊天内容。

注意：人民币换算只覆盖 Pi 主 TUI 的底栏和右侧栏；子代理查看器的 usage 行仍按 Pi 原始逻辑显示 USD。

## 网络与浏览器数据边界

`pi.nix` 安装 `pi-web-access`，并写入 `~/.pi/web-search.json`：

- 仅额外允许本机 Clash/Mihomo fake-IP 使用的 `198.18.0.0/15`，不会因此放行 localhost、私网或字面 IP；
- `allowBrowserCookies = true` 是显式 opt-in，用于 Gemini Web 的 Chromium cookie 提取。

这使公网抓取能适配当前代理的 fake-IP DNS，同时保留包自身的 SSRF 预检。若不需要 Gemini Web cookie，可关闭该选项。

## 技能与文件落点

Home Manager 将配置写入以下位置：

```text
~/.pi/agent/AGENTS.md             # agent-context.md
~/.pi/agent/extensions/           # 权限、侧栏、Todo、子代理等扩展
~/.pi/agent/agents/               # general.md、explore.md
~/.pi/agent/skills/               # 本地与外部技能
~/.pi/agent/models.json
~/.pi/agent/keybindings.json
~/.pi/web-search.json
```

技能来源包括本地 `agent/skills`、Anthropic 的 docx/pptx/xlsx/pdf/canvas-design、`media-processor` 和 `idea-refine`。`superpowers` 在此配置中目前未启用（对应注释保留在 `pi.nix`）。

## 维护提示

修改 `pi.nix` 的 overlay patch、Pi 版本或扩展 API 后，应优先检查：权限闸门是否仍覆盖新增工具、sidebar patch 与 `setExtensionSidebar` API 是否匹配、子代理的进程组终止是否仍能清理孙进程，以及模型目录是否继续提供 1,050,000 上下文。

当前 `skills.nix` 的外部 `builtins.fetchGit` 使用 `main`，没有固定 revision/hash；若需要严格可复现，应在更新技能时固定这些输入。扩展源码由 Home Manager 以声明式文件方式部署，不建议直接修改 `~/.pi/agent/` 下的生成文件。
