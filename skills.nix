{ config, pkgs, lib, ... }:

let
  anbeime-skills-repo = builtins.fetchGit {
    url = "https://github.com/anbeime/skill.git";
    ref = "main";
  };

  anthropics-skills-repo = builtins.fetchGit {
    url = "https://github.com/anthropics/skills.git";
    ref = "main";
  };

  agent-skills-repo = builtins.fetchGit {
    url = "https://github.com/addyosmani/agent-skills.git";
    ref = "main";
  };
in
{
  home.file = {
    # ---- 本地技能（agent/skills/）----
    ".pi/agent/skills/" = {
      source = ../skills;
      recursive = true;
    };

    # ---- anthropics/skills ----
    ".pi/agent/skills/docx".source = "${anthropics-skills-repo}/skills/docx";
    ".pi/agent/skills/pptx".source = "${anthropics-skills-repo}/skills/pptx";
    ".pi/agent/skills/xlsx".source = "${anthropics-skills-repo}/skills/xlsx";
    ".pi/agent/skills/pdf".source = "${anthropics-skills-repo}/skills/pdf";
    ".pi/agent/skills/canvas-design".source = "${anthropics-skills-repo}/skills/canvas-design";

    # ---- anbeime/skill ----
    ".pi/agent/skills/media-processor".source = "${anbeime-skills-repo}/skills/media-processor/media-processor";

    # ---- addyosmani/agent-skills ----
    ".pi/agent/skills/idea-refine".source = "${agent-skills-repo}/skills/idea-refine";
  };
}
