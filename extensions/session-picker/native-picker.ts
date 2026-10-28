import { SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

type SelectorArgs = ConstructorParameters<typeof SessionSelectorComponent>;
type SessionsLoader = SelectorArgs[0];
type SelectorOptions = NonNullable<SelectorArgs[6]>;

export class CopyableSessionSelector extends SessionSelectorComponent {
  private readonly copyHint = new Text("Ctrl+Alt+C copy · Ctrl+Alt+V paste copied session", 1, 0);
  private copyHintText = "Ctrl+Alt+C copy · Ctrl+Alt+V paste copied session";
  private pastePending = false;
  private readonly selectPath: (path: string) => void;
  private readonly rerender: () => void;

  constructor(
    currentSessionsLoader: SessionsLoader,
    allSessionsLoader: SessionsLoader,
    onSelect: (sessionPath: string) => void,
    onCancel: () => void,
    onExit: () => void,
    requestRender: () => void,
    options: SelectorOptions,
    currentSessionFilePath: string | undefined,
    private readonly getCopiedPath: () => string | undefined,
    private readonly copyPath: (path: string) => void,
    private readonly pastePath: (sourcePath: string) => Promise<string>,
    private readonly reportError: (error: unknown) => void,
    private readonly reportCopied: (path: string) => void,
  ) {
    super(currentSessionsLoader, allSessionsLoader, onSelect, onCancel, onExit, requestRender, options, currentSessionFilePath);
    this.selectPath = onSelect;
    this.rerender = requestRender;
  }

  override render(width: number): string[] {
    const hint = this.pastePending ? "Copying session and subagent sessions…" : "Ctrl+Alt+C copy · Ctrl+Alt+V paste copied session";
    if (hint !== this.copyHintText) {
      this.copyHintText = hint;
      this.copyHint.setText(hint);
    }
    const list = this.getSessionList();
    if (this.children.includes(list) && !this.children.includes(this.copyHint)) {
      const bottomBorderIndex = Math.max(0, this.children.length - 1);
      this.children.splice(bottomBorderIndex, 0, new Spacer(1), this.copyHint);
    }
    return super.render(width);
  }

  override handleInput(data: string): void {
    const listIsVisible = this.children.includes(this.getSessionList());
    if (!listIsVisible) {
      super.handleInput(data);
      return;
    }
    if (this.pastePending) return;

    if (matchesKey(data, "ctrl+alt+c")) {
      const selectedPath = this.getSessionList().getSelectedSessionPath();
      if (selectedPath) {
        this.copyPath(selectedPath);
        this.reportCopied(selectedPath);
      } else this.reportError(new Error("No session selected to copy."));
      this.rerender();
      return;
    }
    if (matchesKey(data, "ctrl+alt+v")) {
      const sourcePath = this.getCopiedPath();
      if (!sourcePath) {
        this.reportError(new Error("No copied session. Select one and press Ctrl+Alt+C first."));
        return;
      }
      this.pastePending = true;
      this.rerender();
      void this.pastePath(sourcePath)
        .then((copyPath) => {
          this.pastePending = false;
          this.rerender();
          this.selectPath(copyPath);
        })
        .catch((error: unknown) => {
          this.pastePending = false;
          this.rerender();
          this.reportError(error);
        });
      return;
    }
    super.handleInput(data);
  }
}
