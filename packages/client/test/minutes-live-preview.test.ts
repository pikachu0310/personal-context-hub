import { ensureSyntaxTree } from "@codemirror/language";
import assert from "node:assert/strict";
import test from "node:test";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  minutesDecorations,
  minutesLivePreview,
} from "../src/ui/minutes-live-preview.js";
const source =
  "## 決定事項\n\n- [x] **確認済み**\n- [設計](ido://projects/p/tasks/t)\n\n| 担当 | 予定 |\n| --- | --- |\n| 開発 | 明日 |\n\n```ts\nconst count = 1;\n```\n";
const stateAt = (line: number) => {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return state.update({ selection: { anchor: state.doc.line(line).from } })
    .state;
};
function ranges(state: EditorState) {
  // Finish parsing explicitly; the background parser budget can expire under parallel CI load.
  ensureSyntaxTree(state, state.doc.length, 1000);
  const result: Array<{ from: number; to: number; spec: any }> = [];
  minutesDecorations(state, () => {}).between(
    0,
    state.doc.length,
    (from, to, value) => {
      result.push({ from, to, spec: value.spec });
    },
  );
  return result;
}
test("only selected source lines reveal Markdown; moving the caret restores the old line", () => {
  const state = stateAt(1),
    first = state.doc.line(1);
  assert.equal(
    ranges(state).some(
      (range) => range.to > range.from && range.from < first.to,
    ),
    false,
  );
  assert.ok(
    ranges(state).some(
      (range) => range.spec.widget && range.from === state.doc.line(4).from + 2,
    ),
  );
  const moved = state.update({
    selection: { anchor: state.doc.line(3).from + 5 },
  }).state;
  const active = moved.doc.line(3);
  assert.equal(
    ranges(moved).some(
      (range) =>
        range.to > range.from &&
        range.from < active.to &&
        range.to > active.from,
    ),
    false,
  );
  assert.ok(ranges(moved).some((range) => range.from === 0 && range.to === 3));
  assert.equal(moved.doc.toString(), source);
});
test("a selected GFM table row and fenced code line stay literal without exposing other rows", () => {
  const table = stateAt(8),
    row = table.doc.line(8);
  assert.equal(
    ranges(table).some(
      (range) =>
        range.to > range.from && range.from < row.to && range.to > row.from,
    ),
    false,
  );
  assert.ok(
    ranges(table).some(
      (range) => range.spec.widget?.constructor.name === "TableRowWidget",
    ),
  );
  const code = stateAt(10);
  assert.equal(
    ranges(code).some(
      (range) => range.from === code.doc.line(10).from && range.to > range.from,
    ),
    false,
  );
  assert.equal(code.doc.toString(), source);
});
test("select-all reveals the exact document without changing the Markdown", () => {
  const field = minutesLivePreview(() => {});
  const initial = EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage }), field],
  });
  const selected = initial.update({
    selection: EditorSelection.single(0, source.length),
  }).state;
  const decorated = ranges(selected);
  assert.equal(
    decorated.some((range) => range.from !== range.to),
    false,
  );
  assert.equal(
    decorated.filter((range) => range.spec.class === "cm-md-source").length,
    selected.doc.lines,
  );
  assert.equal(selected.doc.toString(), source);
});
test("unresolved Markdown labels remain visible rather than becoming fake links", () => {
  const state = EditorState.create({
    doc: "active\n\n[missing]\n[unsafe](javascript:alert)\n",
    extensions: [markdown({ base: markdownLanguage })],
  });
  const values = ranges(state);
  assert.equal(
    values.some((range) => range.spec.widget?.parts?.label === "missing"),
    false,
  );
  const unsafe = values.find(
    (range) => range.spec.widget?.parts?.label === "unsafe",
  );
  assert.equal(unsafe?.spec.widget.parts.href, "");
});
