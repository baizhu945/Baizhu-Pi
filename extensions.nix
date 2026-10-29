
{ pkgs, config, ... }:

let
  auditDependencies = pkgs.linkFarm "pi-plugin-audit-dependencies" (map (name: {
    inherit name;
    path = config.home.file.".pi/agent/extensions/${name}".source;
  }) [ "pi-goal" "rpiv-ask-user-question" "pi-subagents" ]);
  pluginAudit = pkgs.runCommand "pi-all-plugin-regressions" {
    nativeBuildInputs = [ pkgs.nodejs pkgs.curl ];
  } ''
    node ${./tests/all-plugin-audit.mjs} \
      ${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo \
      ${./extensions} ${auditDependencies}
    node ${./tests/permission.test.mjs} ${./extensions/permission/index.ts}
    touch "$out"
  '';
in

{
  home.extraDependencies = [ pluginAudit ];
  imports = [
    ./extensions/subagents.nix
    ./extensions/tasks.nix
    ./extensions/rpiv-ask-user-question.nix
    ./extensions/pi-goal.nix
    ./extensions/pi-web-access.nix
    ./extensions/pi-open-tui.nix
  ];

  home.file = {
    ".pi/agent/extensions/session-picker" = {
      source = ./extensions/session-picker;
      recursive = true;
    };

    ".pi/agent/extensions/background-commands" = {
      source = ./extensions/background-commands;
      recursive = true;
    };

    ".pi/agent/extensions/permission" = {
      source = ./extensions/permission;
      recursive = true;
    };
  };
}
