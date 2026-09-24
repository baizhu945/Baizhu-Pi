{ pkgs, ... }:

{
  imports = [
    ./subagents.nix
    ./skills.nix
  ];

  programs.pi-coding-agent = {
    enable = true;

    # 让技能脚本可用的 nodejs（与 opencode.nix 的 extraPackages 一致）
    extraPackages = with pkgs; [ nodejs ];

    # 全局 context：与 opencode.nix 使用同一个 agent-context.md
    # 模块会将其写入 ~/.pi/agent/AGENTS.md
    context = ../agent-context.md;

    settings = {
      # 项目级资源（.pi/settings.json、项目 skills 等）默认询问是否信任
      defaultProjectTrust = "ask";

      # （defaultProvider 必须与 defaultModel 一起设置，模型解析器两者都需要）
      defaultProvider = "openai-codex";
      defaultModel = "gpt-6-luna";
      defaultThinkingLevel = "xhigh";

      # 思维链默认展开（false = 不隐藏 thinking 块）；ctrl+t / alt+t 可随时折叠/展开
      hideThinkingBlock = false;

      retry.enabled = true;
      retry.maxRetries = 5;

      packages = [
        "npm:@juicesharp/rpiv-ask-user-question"
        "npm:pi-web-access"
        "npm:@narumitw/pi-goal"
        "npm:@tintinweb/pi-tasks"

        "npm:pi-open-tui"
      ];
    };
  };

  # skills：pi 的全局技能根是 ~/.pi/agent/skills/，逐个软链（reasonix.nix 同款做法）
  home.file = {
    # pi-web-access 0.29+ 默认从 Pi 的 agent 配置目录读取此文件。本机
    # Clash/Mihomo TUN 代理把公网域名解析成 198.18.0.0/15 的 fake-IP，
    # 导致包内 SSRF DNS 预检拦截所有抓取。仅放行该代理合成网段
    # （私网/localhost/字面 IP 仍被拦截，安全语义不变）。
    # allowBrowserCookies：启用 Gemini Web 的 Chromium cookie 提取；默认关闭，
    # 避免子代理/网络扩展读取浏览器会话数据。需要时再显式改为 true。
    ".pi/agent/web-search.json".text = ''
      {
        "ssrf": {
          "allowRanges": ["198.18.0.0/15"]
        },
        "allowBrowserCookies": false
      }
    '';

    ".pi/agent/extensions" = {
      source = ./extensions;
      recursive = true;
    };

    # ---- 快捷键：思维链折叠/展开（alt+t 为未占用的新键，ctrl+t 为内置默认）----
    ".pi/agent/keybindings.json".source = ./keybindings.json;

    ".pi/agent/models.json".source = ./models.json;
  };
}
