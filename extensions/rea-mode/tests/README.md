# Native MCP 1.0.3 hardening regressions

No paid model: **no session.prompt(), provider request, API key, REA backend or Ghidra is used**. Tests use the official SDK/MCP classes, in-memory protocol transports, and actual local Node stdio subprocesses. Only the lazy-import test uses a TEST-ONLY deferred import in a temporary SDK copy; this hook is not in either production patch.

## Reproduce locally

From a writable copy of the extension:

```sh
node tests/build-patches.mjs /nix/store/ybsnz4v6fzl73dx2alwimf9518cry6ny-source /path/to/pi-monorepo
node tests/run.mjs /path/to/UNPATCHED/pi-monorepo
```

The generator verifies every replacement uniquely matches the exact upstream input, emits both source and dist patches, and never changes installed files. run.mjs copies `dist/` and `package.json` under `tests/.runs`, symlinks the installed dependency tree read-only, applies the dist patch **only to that copy**, then runs eight independent Node tests. `latest-run.log` is the last real execution output. `.runs/` and `.generated/` are disposable, do not deploy them with Home Manager.

For the Pi package rebuilt by the main agent from the **source patch**:

```sh
node tests/run.mjs /path/to/SOURCE-PATCHED/pi-monorepo --built
```

`--built` skips applying the dist patch, so the tests validate the actual compiled source result. It still makes a writable SDK copy for the test-only lazy-import gate. In Nix installCheck, copy this extension/tests/patches into a writable temporary directory first (`chmod -R u+w`), then run with `$out`'s SDK root. No package-manager dependency installation is required; Node and `patch` suffice.

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

After `build-patches.mjs` generates `tests/.generated/`, `node tests/check-source.mjs [sourceRoot] [sdkRoot] [tsc]` compares strict TypeScript diagnostics on patched vs exact unpatched upstream dependency graphs. The installed runtime SDK lacks upstream dev declaration packages (proper-lockfile/semver/cross-spawn/etc.), so this local check reported **identical pre-existing diagnostics, no added patch diagnostics**, not a complete source-build success. The main agent must still run Nix's full upstream build and then `run.mjs ... --built`.

The source patch changes only `packages/coding-agent/src/extensions/mcp/{index,runtime}.ts`; apply it before Pi's TS/bundle compilation. The dist patch is a diagnostic/testing companion, not the deployment solution. Controller `index.ts`/config timeout/watch logic has NOT been shortened by this follow-up. With the source hardening deployed, correctness of late-registration suppression no longer depends on waiting 600 seconds: the native server/connection identities and pending-client cancellation enforce it. A 31-second controller cleanup safety window is conservative for the ordinary native stdio 0.5s+2s termination sequence, but its use should follow the main agent's source rebuild and compiled-result regression run. No finite watcher can prove physical exit of an uninterruptible OS process or a malicious custom transport; public unregister remains void.
