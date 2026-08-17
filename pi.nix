{ config, pkgs, lib, ... }:

{
  # 用 nixpkgs overlay 给 pi 打补丁：底部消费金额以人民币（¥）显示，而非美元（$）
  # 补丁见 cost-cny.patch；汇率由 currency-rate.ts 扩展实时抓取写入 PI_USD_CNY_RATE
  # （扩展不可用时回退到固定值 7.2）
  # bash-timeout.patch：模型未传 timeout 时默认 120s（展示并执行），恢复命令卡片上
  # 始终显示 timeout 的行为（见 0.84.1 升级前的默认显示）
  nixpkgs.overlays = [
    (final: prev: {
      pi-coding-agent = prev.pi-coding-agent.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [ 
          ./patches/cost-cny.patch 
          ./patches/sidebar-layout.patch 
          ./patches/bash-timeout.patch 
          ./patches/main-screen-selection.patch 
          ./patches/unwrap-copy.patch 
          ./patches/sidebar-scroll.patch ];
      });
    })
  ];

  imports = [
    ./skills.nix
    ../cc-connect.nix
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

      # 默认模型：DeepSeek V4 Flash
      # （defaultProvider 必须与 defaultModel 一起设置，模型解析器两者都需要）
      defaultProvider = "openai";
      defaultModel = "gpt-5.6-luna";
      defaultThinkingLevel = "xhigh";

      # 思维链默认展开（false = 不隐藏 thinking 块）；ctrl+t / alt+t 可随时折叠/展开
      hideThinkingBlock = false;

      retry.enabled = true;
      retry.maxRetries = 5;

      packages = [
        "npm:@d3ara1n/pi-ask-user@2.4.2"
        "npm:pi-web-access@0.18.0"
        "npm:@narumitw/pi-goal"

        # "git:github.com/obra/superpowers"
      ];
    };
  };

  # skills：pi 的全局技能根是 ~/.pi/agent/skills/，逐个软链（reasonix.nix 同款做法）
  # 权限 gate：~/.pi/agent/extensions/ 下的 .ts 会被 pi 自动发现并加载
  home.file = {
    # pi-web-access 配置：本机 Clash/Mihomo TUN 代理把公网域名解析成 198.18.0.0/15
    # 的 fake-IP，导致包内 SSRF DNS 预检拦截所有抓取。仅放行该代理合成网段
    # （私网/localhost/字面 IP 仍被拦截，安全语义不变）。
    # allowBrowserCookies：启用 Gemini Web 的 Chromium cookie 提取（opt-in，
    # 默认关闭以免触碰浏览器数据）。
    ".pi/web-search.json".text = ''
      {
        "ssrf": {
          "allowRanges": ["198.18.0.0/15"]
        },
        "allowBrowserCookies": true
      }
    '';

    ".pi/agent/extensions/" = {
      source = ./extensions;
      recursive = true;
    };

    ".pi/agent/agents/" = {
      source = ./agents;
      recursive = true;
    };

    # ---- 快捷键：思维链折叠/展开（alt+t 为未占用的新键，ctrl+t 为内置默认）----
    ".pi/agent/keybindings.json".source = ./keybindings.json;

    ".pi/agent/models.json".source = ./models.json;
  };
}
