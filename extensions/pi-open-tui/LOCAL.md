# Local pi-open-tui

Vendored from the installed pi-open-tui 0.3.11 package, with its MIT license.
Home Manager deploys the source and checks it against the exact Pi SDK. Pi
supplies all peer dependencies; no package-manager installation is needed.
The previous npm copy is no longer loaded by Pi settings.

Local fixes validate configuration sections, preserve invalid settings files,
save settings atomically, bound narrow-terminal header output, and parse Git
branches with both ahead/behind counters. Settings remain in the mutable
agent/open-tui.json file. Existing Pi processes need /reload or a restart.
