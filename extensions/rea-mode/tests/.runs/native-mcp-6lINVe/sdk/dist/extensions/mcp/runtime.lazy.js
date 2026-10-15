/** Loads the MCP client, transports, and OAuth sign-in on first use (see runtime.ts). */
export const loadMcpRuntime = async () => { const gate = globalThis[Symbol.for("rea-tests:lazy-gate")]; if (gate) { gate.enter(); await gate.wait; } return import("./runtime.js"); };
//# sourceMappingURL=runtime.lazy.js.map