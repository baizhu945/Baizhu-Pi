#!/nix/store/gxq2cd70i077rah1d4hkzc1lpq8q4pv8-nodejs-24.21.0/bin/node
import { createRequire, enableCompileCache } from "node:module";

enableCompileCache();
createRequire(import.meta.url)("./cli-runtime.js");
