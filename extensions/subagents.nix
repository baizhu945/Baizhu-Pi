{ pkgs, lib, ... }:

let
  # Bundle the four runtime-only npm dependencies in a Nix derivation. The
  # fork is a local auto-discovered extension, so it cannot rely on the old
  # pi package manager's node_modules tree for bare imports.
  piSubagentsTypebox = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@sinclair/typebox/-/typebox-0.34.49.tgz";
    hash = "sha256-+qQOQeVjP4MSaZLDY4z58lyjWnFBdEwvrF7MhjeYqfQ=";
  };
  piSubagentsCroner = pkgs.fetchurl {
    url = "https://registry.npmjs.org/croner/-/croner-10.0.1.tgz";
    hash = "sha256-1tk8KGEl/tVnuYaldv8dqnTnLVa7Y/4oJIyhfPywDO4=";
  };
  piSubagentsNanoid = pkgs.fetchurl {
    url = "https://registry.npmjs.org/nanoid/-/nanoid-5.1.16.tgz";
    hash = "sha256-0/2cvcnmyPlhepLmsGowjFamLHRPdI45PRAgOGbBs/g=";
  };
  piSubagentsTypeboxRuntime = pkgs.fetchurl {
    url = "https://registry.npmjs.org/typebox/-/typebox-1.3.7.tgz";
    hash = "sha256-sdCUJWDmSTbKnOMolJtabIJY6NCFEa3bfuu1TP2ghjo=";
  };

  piSubagentsFork = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-subagents-local-fork";
    version = "0.19.0";
    src = ./subagents;
    nativeBuildInputs = [ pkgs.gnutar ];
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      mkdir -p "$out"
      cp -R ./. "$out/"

      mkdir -p "$out/node_modules/@sinclair"
      tar -xzf ${piSubagentsTypebox} -C "$out/node_modules/@sinclair"
      mv "$out/node_modules/@sinclair/package" "$out/node_modules/@sinclair/typebox"

      for dependency in croner nanoid typebox; do
        mkdir -p "$out/node_modules/$dependency"
      done
      tar -xzf ${piSubagentsCroner} -C "$out/node_modules/croner"
      tar -xzf ${piSubagentsNanoid} -C "$out/node_modules/nanoid"
      tar -xzf ${piSubagentsTypeboxRuntime} -C "$out/node_modules/typebox"
      for dependency in croner nanoid typebox; do
        target="$out/node_modules/$dependency"
        find "$target/package" -mindepth 1 -maxdepth 1 -exec mv {} "$target/" \
        \;
        rmdir "$target/package"
      done
    '';
  };
in
{
  # Local pi-subagents fork, including its Nix-bundled runtime dependencies.
  home.file.".pi/agent/extensions/pi-subagents" = {
    source = piSubagentsFork;
    recursive = true;
  };

  # The local fork owns Explore's model inheritance. Remove old npm copies so
  # Pi cannot discover a stale compiled package with the previous Haiku pin.
  home.activation.piSubagentsLegacyCleanup = lib.hm.dag.entryAfter [ "installPackages" ] ''
    for target in \
      "$HOME/.pi/agent/npm/node_modules/@tintinweb/pi-subagents" \
      "$HOME/.pi/agent/npm/node_modules/pi-subagents"; do
      if [ -e "$target" ] || [ -L "$target" ]; then
        run /run/current-system/sw/bin/remove-without-permission -rf "$target"
      fi
    done
  '';
}
