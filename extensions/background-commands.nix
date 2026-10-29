{ config, lib, pkgs, ... }:

{
  home.file = {
    ".pi/agent/extensions/background-commands" = {
      source = ./background-commands;
      recursive = true;
    };
  };
}
