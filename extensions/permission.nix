{ config, pkgs, lib, ... }:

{
  home.file = {
    ".pi/agent/extensions/permission" = {
      source = ./permission;
      recursive = true;
    };
  };
}
