import type { Component, EditorComponent } from "@earendil-works/pi-tui";

export function routeResume(text: string): string {
  return text.trim() === "/resume" ? "/session-picker" : text;
}

export type SubmitRoutes = WeakMap<EditorComponent, NonNullable<EditorComponent["onSubmit"]>>;

/** Use the live, focused editor's public callback, even after another extension replaces it. */
export function routeFocusedEditor(focused: Component | null, mainText: string, routes: SubmitRoutes): boolean {
  const editor = focused as EditorComponent | null;
  if (
    mainText.trim() !== "/resume" || !editor ||
    typeof editor.getText !== "function" || editor.getText() !== mainText ||
    typeof editor.onSubmit !== "function"
  ) return false;

  const submit = editor.onSubmit;
  if (routes.get(editor) === submit) return true;
  const routed = (text: string) => submit.call(editor, routeResume(text));
  routes.set(editor, routed);
  editor.onSubmit = routed;
  return true;
}
