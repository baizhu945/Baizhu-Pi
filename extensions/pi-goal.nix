{ pkgs, ... }:

let
  # Local source entry, with the same pinned runtime dependencies as upstream.
  piTuiKit = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@narumitw/pi-tui-kit/-/pi-tui-kit-0.59.0.tgz";
    hash = "sha512-KBbOcciJD+HVbeduUwBUiSy2AehMGYeOwiRPXvac5tcjuh3SDoQ+7qsNPt2s/ku6exJKZp0GYtAVsiu5ySddmA==";
  };
  grokMermaid = pkgs.fetchurl {
    url = "https://registry.npmjs.org/grok-mermaid/-/grok-mermaid-0.2.3.tgz";
    hash = "sha512-/4KopAbsjvuRP9MdPtlDjOHUmUVEohOX73JNcsWpzAtFxh+bq5+Dhb6gzvRieLDwIPQIR3/vy8V1NNTuz4Zsmg==";
  };
  highlightJs = pkgs.fetchurl {
    url = "https://registry.npmjs.org/highlight.js/-/highlight.js-11.12.0.tgz";
    hash = "sha512-nbfWpyRMcMrPMmDwJB+dhX/eiaPKtc2RB+0QZskqJ3WjRA/FDS0e9hZrx8EC/lbEv8gXy98FcDbNa/dspAaJMg==";
  };

  piGoalLocal = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-goal-local";
    version = "0.54.8-local.2";
    src = ./pi-goal;
    nativeBuildInputs = [ pkgs.gnutar pkgs.nodejs ];
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp index.ts package.json LICENSE README.md LOCAL.md "$out/"
      cp -R src docs "$out/"
      mkdir -p "$out/node_modules/@narumitw/pi-tui-kit" \
        "$out/node_modules/grok-mermaid" "$out/node_modules/highlight.js"
      tar -xzf ${piTuiKit} --strip-components=1 -C "$out/node_modules/@narumitw/pi-tui-kit"
      tar -xzf ${grokMermaid} --strip-components=1 -C "$out/node_modules/grok-mermaid"
      tar -xzf ${highlightJs} --strip-components=1 -C "$out/node_modules/highlight.js"
      runHook postInstall
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      node test/neutrality.mjs \
        ${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo "$out"
      runHook postInstallCheck
    '';
  };
in
{
  home.file.".pi/agent/extensions/pi-goal" = {
    source = piGoalLocal;
    recursive = true;
  };
}
