# Native MCP 1.1.0 hardening regressions

No paid model: **no session.prompt(), provider request, API key, REA backend or Ghidra is used**. Tests use the official SDK/MCP classes, in-memory protocol transports, and actual local Node stdio subprocesses. Only the lazy-import test uses a TEST-ONLY deferred import in a temporary SDK copy; this hook is not in either production patch.

## Reproduce locally

The source patch is rebased onto Pi 1.1.0's AbortController-based connection/session implementation, preserving upstream attempt-ownership checks. The old `build-patches.mjs`, `check-source.mjs` and `native-mcp-hardening.patch` are **1.0.3 diagnostic helpers**, not the current deployment path. Do not use the old generator to overwrite the migrated source patch or apply the old dist patch to newer Pi versions.

From a writable copy of the extension, test the Pi 1.1.0 package rebuilt from the **source patch**:

```sh
node tests/run.mjs /path/to/SOURCE-PATCHED/pi-monorepo --built
```

`--built` skips applying the dist patch, so the tests validate the actual compiled source result. It copies `dist/` and `package.json` under `tests/.runs`, symlinks the installed dependency tree read-only, then inserts the test-only lazy-import gate in that writable copy. The matching SDK path is required explicitly; there is no hardcoded old-store default. The runner reports the actual SDK version and refuses the legacy dist patch for versions other than 1.0.3. `latest-run.log` records the last local execution; `.runs/` and `.generated/` are disposable and must not be deployed.

Home Manager automatically runs all eight tests with `--built` in Pi's installCheck, against `$out`'s SDK root. It also checks the controller with the actual 138-tool REA backend and the complete declared extension composition. No package-manager dependency installation or paid model request is required.

## Assertions

1. Cold session with no servers does not call the lazy runtime loader; unregister while a deferred import waits prevents ANY transport creation/tools publication after releasing that import.
2. Pending tools/list is cancelled by close (not the 600-second request timeout); late result cannot publish tools.
3. Concurrent reconnects share one replacement; teardown of the old client does not touch the replacement.
4. Terminal close awaits a detached client's in-flight teardown; concurrent reconnect cannot reopen a terminally closed connection.
5. Reentrant close in createTransport also closes an as-yet-unattached transport and never starts it.
6. **Real SDK/stdio initialize-gated server**: unregister closes stdin, fixture receives SIGTERM, process PID is gone. New SDK session, with the REA controller explicitly loaded and asserted present, has zero REA tools/registrations/policy.
7. Same real subprocess cancellation with tools/list gated; no late publication and zero REA state in the new session.
8. **Real SDK same-name server replacement**: old gated process terminates; new process stays alive with exactly its healthy tool, then unregister terminates it independently.

The gated fixture deliberately remains alive after stdin EOF so SIGTERM/process-group teardown is actually observed. Tests fail on missing process exit rather than pretending void unregister is a cleanup acknowledgment.

## Source typing / limitations

The historical 1.0.3 `check-source.mjs` only compared diagnostics using installed runtime dependencies, which lack upstream dev declarations. That was not a complete source-build success. The 1.0.4 full Nix upstream TypeScript/bundle build and all eight compiled-result regressions passed. For each upgrade, Home Manager again requires the full build and compiled-result tests. The unpatched 1.1.0 negative control passes six tests (including the now-upstream lazy-import cancellation fix), but still fails detached teardown waiting and unattached transport cleanup. Simply removing the entire source patch is therefore insufficient.

The source patch changes only `packages/coding-agent/src/extensions/mcp/{index,runtime}.ts`; apply it before Pi's TS/bundle compilation. The dist patch is a diagnostic/testing companion, not the deployment solution. Controller `index.ts`/config timeout/watch logic has NOT been shortened by this follow-up. With the source hardening deployed, correctness of late-registration suppression no longer depends on waiting 600 seconds: the native server/connection identities and pending-client cancellation enforce it. A 31-second controller cleanup safety window is conservative for the ordinary native stdio 0.5s+2s termination sequence, but its use should follow the main agent's source rebuild and compiled-result regression run. No finite watcher can prove physical exit of an uninterruptible OS process or a malicious custom transport; public unregister remains void.
