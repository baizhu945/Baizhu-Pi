#!/nix/store/gxq2cd70i077rah1d4hkzc1lpq8q4pv8-nodejs-24.21.0/bin/node
import { APP_NAME } from "./config.js";
import { configureHttpDispatcher } from "./core/http-dispatcher.js";
import { main } from "./main.js";
process.title = `${APP_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => { });
configureHttpDispatcher();
main(["--mode", "rpc", ...process.argv.slice(2)]);
//# sourceMappingURL=rpc-entry.js.map