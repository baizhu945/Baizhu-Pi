import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrivialShell } from "../src/nudge.js";
import { leadPolicy, EDIT_NUDGE, bashNudge } from "../src/prompts.js";

test("recognizes read-only trivial shell commands", () => {
  for (const command of ["git status", "ls -la src", "cd /x && git log --oneline -3", "rg -n foo packages"]) {
    assert.equal(isTrivialShell(command), true, command);
  }
});

test("rejects implementation and chained shell commands", () => {
  for (const command of ["npm test", "git commit -m x", "ls | wc -l", "git status && npm run build", "python3 script.py"]) {
    assert.equal(isTrivialShell(command), false, command);
  }
});

test("fake read-only shells and dangerous arguments are not trivial", () => {
  for (const command of [
    "env npm test", "env FOO=bar sh -c mutate", "env --chdir=/tmp touch file", "env -S 'npm test'",
    "find . -delete", "find . -exec touch file +", "find . -execdir echo changed +", "find . -fprint result.txt", "find . -fprintf result.txt '%p'",
    "echo changed > file", "echo changed >> file", "cat < secret", "pwd 2>/tmp/error", "echo $(touch changed)", "echo `touch changed`",
    "git branch -D topic", "git branch -m topic renamed", "git branch new", "git branch --set-upstream-to=origin/main",
    "git remote add origin url", "git remote set-url origin url", "git remote show origin",
    "git diff --output=diff.txt", "git log --output log.txt", "git show --ext-diff", "git diff --textconv", "git -c alias.x=touch x",
    "rg --pre='touch file' pattern", "date --set=tomorrow", "date --se tomorrow", "date -s tomorrow", "file -C -m magic", "file --comp magic", "git diff --out=result", "git show --ext", "tmux capture-pane", "npm view foo --onload-script=mutate",
    "cd /tmp && env npm test", "git status\nnpm test", "'unclosed", "echo harmless; touch changed",
  ]) assert.equal(isTrivialShell(command), false, command);
});

test("ordinary shell inspection remains trivial without granting command execution", () => {
  for (const command of ["env", "env -0", "printenv HOME", "find . -name '*.ts' -print", "git branch", "git branch --show-current", "git remote -v", "git diff --stat", "date -d yesterday", "cd '/x y' && ls -la", "tmux capture-pane -p"]) {
    assert.equal(isTrivialShell(command), true, command);
  }
});

test("concise guidance keeps delegation exceptions and invocation rules", () => {
  const policy = leadPolicy({ leadName: "lead", leadEffort: "", sidekickName: "side", sidekickEffort: "" });
  for (const text of [policy, EDIT_NUDGE, bashNudge(4)]) {
    assert.match(text, /sidekick/);
    assert.match(text, /correctness-critical/);
    assert.match(text, /urgent/);
    assert(text.length < 1200);
  }
  assert.match(policy, /only your brief/);
  assert.match(policy, /block:false/);
  assert.match(policy, /same sidekick/);
  assert.match(policy, /read_subagent/);
  assert.match(policy, /review its result/);
});
