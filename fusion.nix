{ pkgs, ... }:

let
  # The extension and UniPi helpers are vendored locally, like pi-subagents.
  # This is the only runtime dependency; Pi supplies its own SDK/TUI modules.
  typebox = pkgs.fetchurl {
    url = "https://registry.npmjs.org/typebox/-/typebox-1.3.7.tgz";
    hash = "sha256-sdCUJWDmSTbKnOMolJtabIJY6NCFEa3bfuu1TP2ghjo=";
  };
  piPackageDir = "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";

  piFusionLocal = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-fusion-local";
    version = "2.20.5-local.2";
    src = ./fusion;
    nativeBuildInputs = [ pkgs.gnutar ];
    nativeCheckInputs = [ pkgs.nodejs ];
    dontConfigure = true;
    dontBuild = true;
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      export HOME="$TMPDIR/fusion-check-home"
      export PI_OFFLINE=1
      # Exercise the actual local subagents wrapper, not a mock. Nix snapshots
      # this test input as well, so the composition regression is reproducible.
      export PI_FUSION_TEST_SUBAGENTS_DIR=${./subagents}
      mkdir -p "$HOME"
      node tests/run.mjs ${piPackageDir}
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -R ./. "$out/"
      mkdir -p "$out/node_modules/typebox"
      tar -xzf ${typebox} --strip-components=1 -C "$out/node_modules/typebox"
      runHook postInstall
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      node tests/neutrality.test.mjs ${piPackageDir} "$out/index.ts"
      runHook postInstallCheck
    '';
  };
in
{
  home.file.".pi/agent/extensions/pi-fusion" = {
    source = piFusionLocal;
    recursive = true;
  };
}
