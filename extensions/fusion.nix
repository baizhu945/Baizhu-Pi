{ pkgs, ... }:

let
  # The extension and UniPi helpers are vendored locally, like pi-subagents.
  # This is the only runtime dependency; Pi supplies its own SDK/TUI modules.
  typebox = pkgs.fetchurl {
    url = "https://registry.npmjs.org/typebox/-/typebox-1.3.7.tgz";
    hash = "sha256-sdCUJWDmSTbKnOMolJtabIJY6NCFEa3bfuu1TP2ghjo=";
  };
  piPackageDir = "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";

  # Type-check against the exact Pi SDK this build ships against, with the
  # host's own compiler settings. No network and no extra package managers.
  fusionTypecheck = pkgs.runCommand "pi-fusion-typecheck" {
    version = "2.20.5-local.4";
    nativeBuildInputs = [ pkgs.nodejs pkgs.typescript ];
  } ''
    cp -R ${./fusion} ./src
    chmod -R u+w ./src
    cat > tsconfig.check.json <<'JSON'
    {
      "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true,
        "noEmit": true,
        "skipLibCheck": true,
        "noImplicitOverride": true,
        "allowImportingTsExtensions": true,
        "verbatimModuleSyntax": true,
        "types": ["node"],
        "typeRoots": ["${piPackageDir}/node_modules/@types"],
        "paths": {
          "@earendil-works/pi-coding-agent": ["${piPackageDir}/dist/index.d.ts"],
          "@earendil-works/pi-tui": ["${piPackageDir}/node_modules/@earendil-works/pi-tui/dist/index.d.ts"],
          "@earendil-works/pi-ai": ["${piPackageDir}/node_modules/@earendil-works/pi-ai/dist/compat.d.ts"],
          "typebox": ["${piPackageDir}/node_modules/typebox/build/index.d.mts"]
        }
      },
      "include": ["src/src/**/*.ts", "src/index.ts"]
    }
    JSON
    tsc -p tsconfig.check.json
    touch "$out"
  '';

  piFusionLocal = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-fusion-local";
    version = "2.20.5-local.4";
    src = ./fusion;
    nativeBuildInputs = [ pkgs.gnutar ];
    nativeCheckInputs = [ pkgs.nodejs pkgs.typescript ];
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
      export PI_FUSION_TEST_BACKGROUND_EXT=${./background-commands.ts}
      export PI_FUSION_TEST_SHELL=${pkgs.bash}/bin/bash
      mkdir -p "$HOME"
      node tests/run.mjs ${piPackageDir}
      echo "Type-check passed against ${piPackageDir}"
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
