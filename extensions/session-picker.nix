{ lib, config, pkgs, ... }:

{
  home.file = {
    ".pi/agent/extensions/session-picker" = {
      source = ./session-picker;
      recursive = true;
    };
  };
}
