{ pkgs, lib }:

let
  packages = (lib.importJSON ../package-lock.json).packages;
  cpu = if pkgs.stdenv.hostPlatform.isx86_64 then "x64" else "arm64";
  compatible = path:
    let package = packages.${path};
    in builtins.elem "linux" (package.os or [ "linux" ])
      && builtins.elem cpu (package.cpu or [ cpu ])
      && !(lib.hasSuffix "-musl" path);

  resolveDependency = parent: name:
    let
      candidate = (if parent == "." then "" else "${parent}/") + "node_modules/${name}";
    in if builtins.hasAttr candidate packages then candidate
      else if parent == "." then throw "Missing locked test dependency: ${name}"
      else resolveDependency (builtins.dirOf parent) name;

  closure = builtins.genericClosure {
    startSet = [
      { key = "node_modules/vitest"; }
      { key = "node_modules/@biomejs/biome"; }
    ];
    operator = { key }:
      let
        package = packages.${key};
        names = builtins.attrNames ((package.dependencies or { }) // (package.optionalDependencies or { }));
        paths = builtins.filter compatible (map (resolveDependency key) names);
      in map (path: { key = path; }) paths;
  };

  unpack = { key }:
    let
      package = packages.${key};
      archive = pkgs.fetchurl {
        url = package.resolved;
        hash = package.integrity;
      };
      target = lib.removePrefix "node_modules/" key;
    in ''
      mkdir -p "$out/${target}"
      tar -xzf ${archive} --strip-components=1 -C "$out/${target}"
    '';
in
pkgs.runCommand "pi-tasks-test-modules" {
  nativeBuildInputs = [ pkgs.gnutar pkgs.autoPatchelfHook ];
  buildInputs = [ pkgs.stdenv.cc.cc.lib ];
} ''
  mkdir -p "$out"
  ${lib.concatMapStringsSep "\n" unpack closure}
  autoPatchelf "$out"
''
