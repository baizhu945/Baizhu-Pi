#!/nix/store/gxq2cd70i077rah1d4hkzc1lpq8q4pv8-nodejs-24.21.0/bin/node
import { setupCli } from "./cli/setup.js";
import { main } from "./main.js";
setupCli();
main(process.argv.slice(2));
//# sourceMappingURL=cli.js.map