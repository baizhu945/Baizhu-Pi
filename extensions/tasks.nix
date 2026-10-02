{ pkgs, lib, ... }:

let
  piPackageDir = "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";
  testModules = import ./tasks/test/modules.nix { inherit pkgs lib; };

  piTasksLocal = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-tasks-local";
    version = "0.9.0-local.1";
    src = ./tasks;
    nativeCheckInputs = [ pkgs.nodejs pkgs.typescript ];
    dontConfigure = true;
    dontBuild = true;
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      export HOME="$TMPDIR/tasks-check-home"
      export PI_OFFLINE=1
      mkdir -p "$HOME" node_modules/@earendil-works
      # Test tools are fetched by Nix. SDK and TypeBox always come from Pi.
      cp -R ${testModules}/. node_modules/
      chmod -R u+w node_modules
      ln -s ${piPackageDir} node_modules/@earendil-works/pi-coding-agent
      ln -s ${piPackageDir}/node_modules/@earendil-works/pi-tui node_modules/@earendil-works/pi-tui
      ln -s ${piPackageDir}/node_modules/typebox node_modules/typebox
      ln -s ${piPackageDir}/node_modules/@types node_modules/@types
      node node_modules/@biomejs/biome/bin/biome check src/ test/ --error-on-warnings
      tsc --noEmit -p tsconfig.json
      node node_modules/vitest/vitest.mjs run --reporter=dot
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp index.ts package.json LICENSE LOCAL.md "$out/"
      cp -R src "$out/"
      runHook postInstall
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      node test/host-loader.mjs "$out"
      runHook postInstallCheck
    '';
  };
in
{
  home.file.".pi/agent/extensions/pi-tasks" = {
    source = piTasksLocal;
    recursive = true;
  };

  # Retire the old npm copy after switching to the declarative local fork.
  home.activation.piTasksLegacyCleanup = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    target="$HOME/.pi/agent/npm/node_modules/@tintinweb/pi-tasks"
    if [ -e "$target" ] || [ -L "$target" ]; then
      run /run/current-system/sw/bin/remove-without-permission -rf "$target"
    fi
  '';
}
