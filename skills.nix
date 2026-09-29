{ config, pkgs, lib, ... }:

let
  anthropics-skills-repo = pkgs.fetchFromGitHub {
    owner = "anthropics";
    repo = "skills";
    rev = "34040c9c568585f6929bedeaad110ad08f079624";
    hash = "sha256-tI4bTTBfI1ylltklGyiyA7pLoKXEWtrT6lrmwrpLbCw=";
  };
in
{
  home.file = {
    # ---- 本机 Pi 使用的本地技能；cc-connect 专用技能由服务入口单独加载 ----
    ".pi/agent/skills/chrome-automation" = {
      source = ../skills/chrome-automation;
      recursive = true;
    };

    # ---- anthropics/skills ----
    ".pi/agent/skills/docx".source = "${anthropics-skills-repo}/skills/docx";
    ".pi/agent/skills/pptx".source = "${anthropics-skills-repo}/skills/pptx";
    ".pi/agent/skills/xlsx".source = "${anthropics-skills-repo}/skills/xlsx";
    ".pi/agent/skills/pdf".source = "${anthropics-skills-repo}/skills/pdf";
    ".pi/agent/skills/canvas-design".source = "${anthropics-skills-repo}/skills/canvas-design";
  };
}
