import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CombinedAutocompleteProvider, Editor,
  type AutocompleteProvider, type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { createMentionProvider } from "@fusion-test/subagents-mention";
import { createModelBoostProvider, MODEL_COMMAND } from "../src/index.js";

const options = () => ({ signal: new AbortController().signal });
const commands = [{ name: "model" }, { name: MODEL_COMMAND }, { name: "resume" }];
const roster = () => [{ kind: "type" as const, handle: "explore", type: "Explore", description: "Explore the codebase" }];
const mention = (base: AutocompleteProvider) => createMentionProvider(base, roster, () => true);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function chain(order: "fusion-inside" | "fusion-outside") {
  const base = new CombinedAutocompleteProvider(commands, "/tmp", null);
  return order === "fusion-inside"
    ? mention(createModelBoostProvider(base))
    : createModelBoostProvider(mention(base));
}

class PrivateProvider implements AutocompleteProvider {
  #value = "private state";
  get triggerCharacters() { return ["#"]; }
  async getSuggestions(): Promise<AutocompleteSuggestions | null> {
    assert.equal(this.#value, "private state");
    return null;
  }
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
    assert.equal(this.#value, "private state");
    return { lines, cursorLine, cursorCol };
  }
  shouldTriggerFileCompletion(lines: string[]) {
    assert.equal(this.#value, "private state");
    return lines[0] === "allow-file";
  }
}

test("class prototype methods, getters and private this state survive the Fusion wrapper", async () => {
  const original = new PrivateProvider();
  assert.equal(Object.hasOwn(original, "applyCompletion"), false);
  const wrapped = createModelBoostProvider(original);
  assert.equal(typeof wrapped.applyCompletion, "function");
  assert.deepEqual(wrapped.triggerCharacters, ["#"]);
  assert.equal(await wrapped.getSuggestions(["/res"], 0, 4, options()), null);
  assert.deepEqual(wrapped.applyCompletion(["/res"], 0, 4, { value: "resume", label: "resume" }, "/res"), {
    lines: ["/res"], cursorLine: 0, cursorCol: 4,
  });
  assert.equal(wrapped.shouldTriggerFileCompletion?.(["allow-file"], 0, 10), true);
  assert.equal(wrapped.shouldTriggerFileCompletion?.(["deny-file"], 0, 9), false);
  // Pi assigns the union of wrapper triggers. It must not mutate the inner
  // class's read-only accessor or fail with a setter/private-state exception.
  wrapped.triggerCharacters = ["#", "@"];
  assert.deepEqual(original.triggerCharacters, ["#"]);
});

test("delegation preserves the original receiver even for own object methods", async () => {
  const original: AutocompleteProvider = {
    async getSuggestions() { assert.equal(this, original); return null; },
    applyCompletion(lines, cursorLine, cursorCol) {
      assert.equal(this, original);
      return { lines, cursorLine, cursorCol };
    },
  };
  const wrapped = createModelBoostProvider(original);
  assert.equal(wrapped.shouldTriggerFileCompletion, undefined);
  await wrapped.getSuggestions(["/res"], 0, 4, options());
  wrapped.applyCompletion(["/res"], 0, 4, { value: "resume", label: "resume" }, "/res");
});

test("model boosting reorders without mutating the inner suggestions", async () => {
  const items = [{ value: "model", label: "model" }, { value: MODEL_COMMAND, label: MODEL_COMMAND }];
  const response = { items, prefix: "/model" };
  const original: AutocompleteProvider = {
    async getSuggestions() { return response; },
    applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
  };
  const wrapped = createModelBoostProvider(original);
  const boosted = await wrapped.getSuggestions(["/model"], 0, 6, options());
  assert.deepEqual(boosted?.items.map(item => item.value), [MODEL_COMMAND, "model"]);
  assert.deepEqual(items.map(item => item.value), ["model", MODEL_COMMAND]);
  assert.equal(await wrapped.getSuggestions(["/res"], 0, 4, options()), response);
});

for (const order of ["fusion-inside", "fusion-outside"] as const) {
  for (const [typed, command] of [["/res", "resume"], ["/unipi:mo", MODEL_COMMAND], ["/model", MODEL_COMMAND]]) {
    test(`real Combined + subagents ${order}: accepts ${typed} without losing applyCompletion`, async () => {
      const provider = chain(order);
      const suggestions = await provider.getSuggestions([typed], 0, typed.length, options());
      assert(suggestions);
      const selected = suggestions.items.find(item => item.value === command);
      assert(selected);
      if (typed === "/model") assert.equal(suggestions.items[0].value, MODEL_COMMAND);
      assert.equal(provider.applyCompletion([typed], 0, typed.length, selected, suggestions.prefix).lines[0], `/${command} `);
    });
  }
  test(`real Combined + subagents ${order}: @ agent completion still works`, async () => {
    const provider = chain(order);
    const suggestions = await provider.getSuggestions(["@ex"], 0, 3, options());
    assert(suggestions);
    const selected = suggestions.items.find(item => item.value === "@explore");
    assert(selected);
    assert.equal(provider.applyCompletion(["@ex"], 0, 3, selected, suggestions.prefix).lines[0], "@explore ");
  });
  for (const key of ["\t", "\r"]) {
    test(`real Editor.handleInput ${order}: slash completion via ${key === "\t" ? "Tab" : "Enter"}`, async () => {
      const id = (text: string) => text;
      const editor = new Editor({ requestRender() {}, terminal: { rows: 24, columns: 80 } } as never, {
        borderColor: id,
        selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
      });
      const submitted: string[] = [];
      editor.onSubmit = text => submitted.push(text);
      editor.setAutocompleteProvider(chain(order));
      editor.setText("/res");
      editor.handleInput("\t");
      await tick();
      assert.equal(editor.isShowingAutocomplete(), true);
      assert.doesNotThrow(() => editor.handleInput(key));
      assert.equal(editor.isShowingAutocomplete(), false);
      if (key === "\t") {
        assert.equal(editor.getText(), "/resume ");
        assert.deepEqual(submitted, []);
      } else {
        assert.deepEqual(submitted, ["/resume"]);
      }
    });
  }
}
