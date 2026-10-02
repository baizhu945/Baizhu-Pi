export const BASH_NUDGE_EVERY = 4;

// This is a conservative delegation heuristic, not a shell safety boundary.
// Reject expansions/operators even inside quotes rather than guessing at them.
function words(command: string): string[] | undefined {
  const tokens: string[] = [];
  let word = "", quote = "", active = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) tokens.push(word);
      word = "";
      active = false;
    } else {
      word += char;
      active = true;
    }
  }
  if (quote) return undefined;
  if (active) tokens.push(word);
  return tokens;
}

function hasLongOption(args: string[], dangerous: string[]): boolean {
  return args.some((arg) => {
    const option = arg.split("=", 1)[0];
    // getopt-style abbreviations must not evade the dangerous-option check.
    return option.startsWith("--") && option.length > 2 && dangerous.some((flag) => flag.startsWith(option));
  });
}

export function isTrivialShell(command: string): boolean {
  let text = command.trim();
  if (/[\n\r`$\\<>|(){}]/.test(text)) return false;
  // Preserve the common read-only "cd path && inspect" convenience only.
  text = text.replace(/^cd\s+(?:"[^"\n]+"|'[^'\n]+'|[^\s;&]+)\s*&&\s*/, "");
  if (/[;&]/.test(text)) return false;
  const tokens = words(text);
  if (!tokens?.length) return false;
  const [name, ...args] = tokens;
  if (name === "env") return args.every((arg) => ["-0", "--null", "--help", "--version"].includes(arg));
  if (name === "git") {
    const [subcommand, ...rest] = args;
    if (hasLongOption(rest, ["--output", "--ext-diff", "--textconv", "--exec", "--config-env"])) return false;
    if (subcommand === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
    if (subcommand === "branch") {
      return rest.every((arg) => /^(?:-a|-r|-v|-vv|-l|--all|--remotes|--list|--show-current|--no-color|--color(?:=\w+)?|--contains(?:=\S+)?|--no-contains(?:=\S+)?|--merged(?:=\S+)?|--no-merged(?:=\S+)?)$/.test(arg));
    }
    return ["status", "log", "diff", "show", "rev-parse"].includes(subcommand ?? "");
  }
  if (name === "find") return !args.some((arg) => /^(?:-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls)$/.test(arg));
  if (name === "rg") return !args.some((arg) => /^(?:--pre|--hostname-bin)(?:=|$)/.test(arg));
  if (name === "date") return !hasLongOption(args, ["--set"]) && !args.some((arg) => /^-[^-]*s/.test(arg));
  if (name === "file") return !hasLongOption(args, ["--compile"]) && !args.some((arg) => /^-[^-]*C/.test(arg));
  if (name === "tmux") return args[0] === "capture-pane" && args.includes("-p") && !args.includes("-b");
  if (name === "npm") return ["view", "whoami", "ls"].includes(args[0] ?? "") && !args.slice(1).some((arg) => /^(?:--(?:onload-script|userconfig|globalconfig|script-shell))(?:=|$)/.test(arg));
  return ["ls", "pwd", "cat", "head", "tail", "wc", "echo", "which", "type", "grep", "stat", "file", "du", "df", "printenv", "whoami"].includes(name);
}
