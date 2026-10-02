
{ pkgs, ... }:

{
  imports = [
    ./extensions/subagents.nix
    ./extensions/fusion.nix
    ./extensions/tasks.nix
    ./extensions/rpiv-ask-user-question.nix
    ./extensions/pi-goal.nix
    ./extensions/pi-web-access.nix
  ];

  home.file = {
    ".pi/agent/extensions/session-picker" = {
      source = ./extensions/session-picker;
      recursive = true;
    };
  };
}
