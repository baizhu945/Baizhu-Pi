# Pi REA mode

仅交互式父会话的 `/rea on` + 人类 TUI 确认启用，使用 Pi 1.0.3 官方 MCP API。

- `/rea on`：确认后才读取同目录 `config.json`、注册 `rea`、等待恰好 138 个工具（REA 6.1.0，可配置）。启动失败/超时回滚。
- `/rea off`：先同步撤销授权，再请求官方 unregister、移除 REA 工具选择；不会恢复旧快照覆盖其他扩展的工具选择。
- `/rea status`：仅 UI 通知；区分逻辑 off、registry hidden 与不可观测的物理进程退出。
- 新建、恢复、切换、fork、clone、reload、shutdown 均撤销授权。保守地在 tree 导航时也关闭；取消导航不会重新开启。

默认只注册控制命令和 hooks：**没有模型可调用的开启工具、MCP 注册、policy、skill、CLI flag、持久化 on、REA package 探测、进程或网络活动**。从未启用的新会话不修改模型 prompt 或 tools。RPC/print/JSON、无 UI、ALS 子代理、Fusion child 均不能开启。确认拒绝前不读取 config。

配置由 Home Manager 生成，不由此扩展写入：

```json
{
  "command": "/nix/store/…-rea/bin/rea",
  "args": ["mcp"],
  "env": {
    "GHIDRA_INSTALL_DIR": "/nix/store/…-ghidra/lib/ghidra",
    "JAVA_HOME": "/nix/store/…-jdk",
    "REA_GHIDRA_STARTUP_TIMEOUT_MS": "1800000",
    "GHIDRA_HEADLESS_MAXMEM": "8G",
    "REA_ANALYSIS_PROVIDER": "ghidra",
    "REA_BROWSER_EXECUTABLE": "/nix/store/…-chromium/bin/chromium",
    "REA_LOG_LEVEL": "silent"
  },
  "timeout": 1860,
  "expectedTools": 138
}
```

`timeout` 单位为秒，用于 native MCP request timeout，最大 3600 秒；当前 1860 秒，为 Ghidra 的 1800000 ms 首次导入/完整自动分析预算留一分钟收尾余量。REA 6.1.0 已原生支持内部预算配置，本地补丁已删除；未指定/无效值按上游逻辑使用 330 秒默认值。headless JVM 最大堆为 8G，不预占全部内存，也不改系统 Ghidra GUI 的环境。控制器的工具就绪等待另有 30 秒上限，取消启动后的保守清理观察不超过 31 秒；Home Manager 同时部署原生 MCP 注销竞态修复，正确性不依赖这个观察窗口。`expectedTools` 缺省 138。env 仅传给 MCP 子进程，不修改 `process.env`；拒绝 env 中 MCP `!command` / `${…}` 插值。工具 exposure 为 `direct`，不会为 REA 自动启用 codemode/tool_search。

启用后提供命名为 `rea` 的 structured system-prompt section：Evidence/unknown、地址/架构/证据来源、交叉验证反编译、非可信数据与破坏性操作确认。MCP 6.1 文件输入使用绝对主机路径；用 `open_binary` 切换目标（`set_current_document` 已删除）。新 EVMole 离线检查使用 Nix 专用 prlimit，不访问链。Python pwntools/pwndbg 等可选引擎没有由此安装。原生分析默认 Ghidra，`open_binary` 只是接受目标，第一次深查询才运行完整导入/分析；大文件超时不等于缺少 Ghidra。REA 只能在授权父 session 使用，不向子代理开放共享会话。与 Fusion forced prompt 共存，不返回新的全量 `systemPrompt`；仅追加自己的 `<rea>` guidance。

**Home Manager 构建的 Pi 1.0.3 已应用 MCP 生命周期 source patch，并在编译产物上运行回归测试，见 `LOCAL.md`。** unregister 的公共 API 仍是 void，不代表调用瞬间物理清理已经完成。工具隐藏后仍可能在内部 registry 留下 hidden 定义/namespace 元数据，但不能作为有效模型工具使用。
