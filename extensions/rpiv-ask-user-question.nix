{ pkgs, ... }:

let
  # Pi supplies its SDK/TUI and TypeBox; only rpiv-config is bundled here.
  rpivConfig = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@juicesharp/rpiv-config/-/rpiv-config-2.12.0.tgz";
    hash = "sha512-eGjoCDCKz2JtKIUIpZ2y8CAVjxZYXCKa2D64ByozhkAWVblXsgyFLrQMk5k5Bv5RXRrA3GY66XNG5ExtEuGASA==";
  };

  rpivAskUserQuestionLocal = pkgs.stdenvNoCC.mkDerivation {
    pname = "rpiv-ask-user-question-local";
    version = "2.12.0-local.1";
    src = ./rpiv-ask-user-question;
    nativeBuildInputs = [ pkgs.gnutar ];
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -R ./. "$out/"
      mkdir -p "$out/node_modules/@juicesharp/rpiv-config"
      tar -xzf ${rpivConfig} --strip-components=1 -C "$out/node_modules/@juicesharp/rpiv-config"
      runHook postInstall
    '';
  };
in
{
  home.file.".pi/agent/extensions/rpiv-ask-user-question" = {
    source = rpivAskUserQuestionLocal;
    recursive = true;
  };
}
