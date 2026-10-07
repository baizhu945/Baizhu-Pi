{ pkgs, ... }:

let
  piPackageDir = "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";
  piOpenTuiLocal = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-open-tui-local";
    version = "0.3.11-local.1";
    src = ./pi-open-tui;
    nativeCheckInputs = [ pkgs.nodejs pkgs.typescript ];
    dontConfigure = true;
    dontBuild = true;
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      cat > tsconfig.check.json <<'JSON'
      {
        "compilerOptions": {
          "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
          "strict": true, "noEmit": true, "skipLibCheck": true,
          "allowImportingTsExtensions": true, "types": ["node"],
          "typeRoots": ["${piPackageDir}/node_modules/@types"],
          "paths": {
            "@earendil-works/pi-coding-agent": ["${piPackageDir}/dist/index.d.ts"],
            "@earendil-works/pi-tui": ["${piPackageDir}/node_modules/@earendil-works/pi-tui/dist/index.d.ts"],
            "@earendil-works/pi-ai": ["${piPackageDir}/node_modules/@earendil-works/pi-ai/dist/index.d.ts"]
          }
        },
        "include": ["index.ts", "extensions/**/*.ts"]
      }
      JSON
      tsc -p tsconfig.check.json
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp index.ts package.json LICENSE README.md README.zh-CN.md LOCAL.md "$out/"
      cp -R extensions "$out/"
      runHook postInstall
    '';
  };
in
{
  home.file.".pi/agent/extensions/pi-open-tui" = {
    source = piOpenTuiLocal;
    recursive = true;
  };
}
