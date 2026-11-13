{ config, pkgs, ... }:

let
  # Pin REA's Node/build package set independently from channel-selected Pi.
  # Node 24.22.1 provides the DatabaseSync.limits API required by REA 6.8.
  pinnedPkgs = (import ../dsh/environment.nix { }).pkgs;
  # REA is a private dependency of the explicit Pi mode, not a global command
  # or an extra package on ordinary Pi's PATH. Never run REA's setup installer.
  rea = let
    inherit (pkgs) lib;
    nodejs = pinnedPkgs.nodejs_24;
    revision = "160d821ac9a0310afcb8d1fc427862dd6508add5";
    packageChecks = pkgs.lib.cleanSourceWith {
      src = ./rea-package;
      filter = path: type: type == "directory" || builtins.elem (baseNameOf path) [
        "schema-portability.mjs" "catalog.mjs" "ghidra-startup-budget.mjs" "sqlite-inspection.mjs"
      ];
    };
  in pinnedPkgs.buildNpmPackage {
    pname = "rea-agents";
    version = "6.8.0";

    src = pinnedPkgs.fetchFromGitHub {
      owner = "morluto";
      repo = "rea";
      rev = revision;
      hash = "sha256-2ADn3U3lvUoB4tCEpzO0rMfYE4sis+5uBiEazcp0gpI=";
    };
    # One 6.8 path-regex portability patch is checked against upstream's
    # canonical parser and the live full-profile schema below.
    patchFlags = [ "-p1" "--fuzz=0" ];
    patches = [ ./rea-package/schema-portability-6.8.patch ];
    inherit nodejs;
    npmDepsHash = "sha256-3WPXD+qm5WVfrTEvepKwX5RZBfbLBcPB0uDmKIx4MR8=";

    # No Husky setup, prepack, Windows artifact verification, or external downloads.
    npmRebuildFlags = [ "--ignore-scripts" ];
    env.HUSKY = "0";
    nativeBuildInputs = [ pinnedPkgs.autoPatchelfHook ];
    buildInputs = [ pinnedPkgs.stdenv.cc.cc.lib ];

    buildPhase = ''
      runHook preBuild
      # Build tools (TypeScript 7 and oxfmt) and PTY contain native Linux binaries.
      # Lockfile includes an unused musl LightningCSS optional variant.
      # The selected glibc natives must resolve; only that foreign libc is exempt.
      autoPatchelfIgnoreMissingDeps=(libc.musl-x86_64.so.1)
      autoPatchelf node_modules
      unset autoPatchelfIgnoreMissingDeps
      node scripts/check-dependency-install.mjs
      npm run compile
      npm run artifacts:skills
      # 6.8 compiles and bundles runtime entries, then generates the shipped
      # skill. MCP catalog cache is test metadata, not a runtime dependency.
      test -s skills/reverse-engineer-anything/SKILL.md
      test ! -e dist/generatedMcpToolCatalog.js
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts
      runtime="$out/lib/rea-agents"
      mkdir -p "$runtime/scripts/lib" "$out/bin"
      cp -r dist bridge skills third_party licenses node_modules "$runtime/"
      cp package.json package-lock.json README.md DISCLAIMER.md THIRD_PARTY_NOTICES.md LICENSE install.sh "$runtime/"
      cp scripts/rea.mjs scripts/electron-active-hook.cjs \
        scripts/electron-active-hook-boundaries.cjs scripts/hopper-demo-x11.py \
        scripts/verify-windows-native-artifact.mjs scripts/prepack.mjs scripts/prepare.mjs \
        "$runtime/scripts/"
      cp scripts/lib/cli-process-environment.mjs "$runtime/scripts/lib/"
      # Absolute Node path, irrespective of the caller's PATH. Do not expose npm.
      cat > "$out/bin/rea" <<EOF
  #!${pinnedPkgs.runtimeShell}
  export PATH="${pinnedPkgs.procps}/bin:\$PATH"
  exec ${nodejs}/bin/node "$runtime/scripts/rea.mjs" "\$@"
  EOF
      chmod +x "$out/bin/rea"
      ln -s rea "$out/bin/rea-agents"
      runHook postInstall
    '';

    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      export HOME="$TMPDIR/rea-install-check"
      export XDG_CONFIG_HOME="$HOME/config"
      export XDG_CACHE_HOME="$HOME/cache"
      mkdir -p "$HOME"
      ${nodejs}/bin/node ${packageChecks}/ghidra-startup-budget.mjs "$out/lib/rea-agents"
      ${nodejs}/bin/node ${packageChecks}/schema-portability.mjs \
        "$out/lib/rea-agents" ${pinnedPkgs.ripgrep}/bin/rg
      ${nodejs}/bin/node ${packageChecks}/sqlite-inspection.mjs "$out/lib/rea-agents" ${pinnedPkgs.procps}/bin
      env PATH=/nonexistent "$out/bin/rea" --version
      env PATH=/nonexistent "$out/bin/rea" mcp doctor --json > "$HOME/mcp-doctor.json"
      ${nodejs}/bin/node --input-type=module - "$HOME/mcp-doctor.json" <<'JS'
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      assert.equal(report.healthy, true);
      assert.equal(report.server.version, '6.8.0');
      assert.equal(report.inventory.tools.expected, report.inventory.tools.observed);
      assert.equal(report.inventory.tools.observed, 229);
      assert.equal(report.inventory.prompts.observed, 6);
      console.log(JSON.stringify(report));
  JS
      runHook postInstallCheck
    '';

    # buildNpmPackage also exposes the actual src and npmDeps derivations.
    passthru = { inherit revision nodejs; };
    meta = {
      description = "Reverse-engineering CLI and MCP server (bring-your-own providers)";
      homepage = "https://github.com/morluto/rea";
      license = lib.licenses.mit;
      mainProgram = "rea";
      platforms = [ "x86_64-linux" "aarch64-linux" ];
    };
  };

  piRuntime = let
    regressionSource = pkgs.lib.cleanSourceWith {
      src = ./extensions/rea-mode;
      filter = path: type:
        if type == "directory" then
          !(builtins.elem (baseNameOf path) [ ".runs" ".generated" ])
        else
          builtins.elem (baseNameOf path) [
            "index.ts" "package.json" "run.mjs" "native-mcp.test.mjs" "gated-server.mjs"
          ];
    };
  in
  # Preserve Pi's version, tools, prompts and defaults. Only fix native MCP
  # connection ownership: a withdrawn server must not spawn or publish late tools,
  # and shutting down a negotiating connection must close its pending transport.
  # Patch source before build so CLI, SDK and bundled outputs stay consistent.
  pkgs.pi-coding-agent.overrideAttrs (old: {
    patchFlags = [ "-p1" "--fuzz=0" ];
    patches = (old.patches or [ ]) ++ [
      ./extensions/rea-mode/native-mcp-source-hardening.patch
    ];
    postInstallCheck = (old.postInstallCheck or "") + ''
      cp -R ${regressionSource} "$TMPDIR/rea-native-mcp-tests"
      chmod -R u+w "$TMPDIR/rea-native-mcp-tests"
      ${pkgs.nodejs}/bin/node \
        "$TMPDIR/rea-native-mcp-tests/tests/run.mjs" \
        "$out/lib/node_modules/pi-monorepo" --built
    '';
  });
  piPackageDir = "${piRuntime}/lib/node_modules/pi-monorepo";
  modeSource = pkgs.lib.cleanSourceWith {
    src = ./extensions/rea-mode;
    filter = path: _type:
      !(builtins.elem (baseNameOf path) [ "tests" "tsconfig.check.json" ])
      && !(pkgs.lib.hasSuffix ".patch" path);
  };
  modeConfig = pkgs.writeText "pi-rea-mode-config.json" (builtins.toJSON {
    command = "${rea}/bin/rea";
    args = [ "mcp" ];
    env = {
      GHIDRA_INSTALL_DIR = "${pinnedPkgs.ghidra}/lib/ghidra";
      JAVA_HOME = "${pinnedPkgs.jdk21}";
      # The first deep query runs a complete headless import/auto-analysis.
      # A 176 MB native target exhausted upstream's fixed 330-second budget.
      REA_GHIDRA_STARTUP_TIMEOUT_MS = "1800000";
      GHIDRA_HEADLESS_MAXMEM = "8G";
      REA_ANALYSIS_PROVIDER = "ghidra";
      # Keep the browser on Pi's existing package set; pinning this to the
      # standalone DSH set would force a separate Chromium source build.
      REA_BROWSER_EXECUTABLE = "${pkgs.chromium}/bin/chromium";
      # Upstream's offline analysis workers default to /usr/bin/prlimit.
      REA_EVM_PRLIMIT_COMMAND = "${pinnedPkgs.util-linux}/bin/prlimit";
      REA_JAVASCRIPT_PRLIMIT_COMMAND = "${pinnedPkgs.util-linux}/bin/prlimit";
      REA_FIRMWARE_PRLIMIT_COMMAND = "${pinnedPkgs.util-linux}/bin/prlimit";
      REA_TSHARK_PRLIMIT_COMMAND = "${pinnedPkgs.util-linux}/bin/prlimit";
      REA_SIGROK_PRLIMIT_COMMAND = "${pinnedPkgs.util-linux}/bin/prlimit";
      REA_LOG_LEVEL = "silent";
      REA_MCP_INPUT_SCHEMA_PROFILE = "full";
    };
    # Pi uses seconds. Leave cleanup margin beyond the 30-minute provider
    # startup budget; cancellation and the 30s MCP readiness cap stay intact.
    # This only affects the explicitly enabled REA server.
    timeout = 1860;
    expectedTools = 229;
  });
  piReaMode = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-rea-mode";
    version = "1.0.0";
    src = modeSource;
    nativeBuildInputs = [ pkgs.nodejs pkgs.typescript ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      cat > tsconfig.check.json <<'JSON'
      {
        "compilerOptions": {
          "target": "ES2023",
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
            "@earendil-works/pi-agent-core": ["${piPackageDir}/node_modules/@earendil-works/pi-agent-core/dist/index.d.ts"]
          }
        },
        "include": ["*.ts", "src/**/*.ts"]
      }
      JSON
      tsc -p tsconfig.check.json
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -R ./. "$out/"
      cp ${modeConfig} "$out/config.json"
      runHook postInstall
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      export HOME="$TMPDIR/pi-rea-check-home"
      export PI_CODING_AGENT_DIR="$HOME/agent"
      export PI_OFFLINE=1
      mkdir -p "$PI_CODING_AGENT_DIR"
      node ${./tests/rea-mode.test.mjs} ${piPackageDir} "$out" ${rea}/bin/rea
      runHook postInstallCheck
    '';
    passthru = { inherit rea modeConfig; };
  };
  # Composition gate: run against the same declared files that activation will
  # deploy, not just a minimal extension fixture. No credentials are included.
  relativeTarget = file: pkgs.lib.removePrefix "${config.home.homeDirectory}/" file.target;
  agentFiles = pkgs.lib.filterAttrs (_name: file:
    let target = relativeTarget file;
    in pkgs.lib.hasPrefix ".pi/agent/extensions/" target
      || builtins.elem target [ ".pi/agent/AGENTS.md" ".pi/agent/settings.json" ]
  ) config.home.file;
  agentFixture = pkgs.linkFarm "pi-rea-declared-agent-fixture" (
    pkgs.lib.mapAttrsToList (_name: file: {
      name = pkgs.lib.removePrefix ".pi/agent/" (relativeTarget file);
      path = file.source;
    }) agentFiles
  );
  compositionChecks = pkgs.runCommand "pi-rea-composition-regressions" {
    nativeBuildInputs = [ pkgs.nodejs ];
  } ''
    export PI_OFFLINE=1
    export PI_SUBAGENTS_TEST_DEPS=${config.home.file.".pi/agent/extensions/pi-subagents".source}
    export PI_SUBAGENTS_TEST_BASELINE_SOURCE=${./tests/rea-mode-support/mention-clone-baseline.ts}
    node ${./tests/rea-installed-neutrality.mjs} ${piPackageDir} ${agentFixture}
    node ${./tests/rea-child-prompts.test.mjs} ${piPackageDir} \
      ${config.home.file.".pi/agent/extensions/pi-subagents".source} ${piReaMode}
    touch "$out"
  '';
in
{
  programs.pi-coding-agent.package = piRuntime;
  home.extraDependencies = [ compositionChecks ];

  # The controller contributes only a human command while off. It registers
  # neither REA tools nor an MCP server until the user confirms /rea on in TUI.
  # No AGENTS, skills, mcp.json, settings, model, or environment defaults change.
  home.file.".pi/agent/extensions/rea-mode" = {
    source = piReaMode;
    recursive = true;
  };
}
