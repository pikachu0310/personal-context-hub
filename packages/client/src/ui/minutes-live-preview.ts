import { StateField, type EditorState, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { parseTaskUrl, type TaskReference } from "@ido/common/contracts/api";
import { minutesUrl } from "./minutes-url.js";

type OpenTask = (reference: TaskReference) => void;
type References = Map<string, string>;
const normalizeLabel = (label: string) =>
  label
    .replace(/^\[|\]$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
const inlineTags: Record<string, string> = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "s",
  InlineCode: "code",
};
const marks = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
]);
function children(node: SyntaxNode) {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling)
    result.push(child);
  return result;
}
function linkParts(
  state: EditorState,
  node: SyntaxNode,
  references: References,
) {
  const source = (from: number, to: number) => state.sliceDoc(from, to);
  const linkMarks = node.getChildren("LinkMark");
  const from = linkMarks[0]?.to ?? node.from;
  const to = linkMarks[1]?.from ?? node.to;
  const label = source(from, to);
  const url = node.getChild("URL"),
    reference = node.getChild("LinkLabel");
  const href = url
    ? source(url.from, url.to).replace(/^<|>$/g, "")
    : (references.get(
        (reference
          ? normalizeLabel(source(reference.from, reference.to))
          : "") || normalizeLabel(label),
      ) ?? "");
  return { from, to, href: minutesUrl(href), label };
}
function linkElement(href: string, openTask: OpenTask): HTMLElement {
  const reference = parseTaskUrl(href);
  const link = document.createElement(href ? "a" : "span");
  if (!(link instanceof HTMLAnchorElement)) return link;
  link.href = reference
    ? `#projects/${reference.projectId}/tasks/${reference.taskId}`
    : href;
  if (reference) {
    link.className = "minutes-task-link";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTask(reference);
    });
    link.addEventListener("auxclick", (event) => event.preventDefault());
  } else {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  // Keep the widget alive until click, rather than moving the editor selection on mousedown.
  link.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return link;
}
function appendInline(
  parent: HTMLElement,
  state: EditorState,
  nodes: SyntaxNode[],
  from: number,
  to: number,
  references: References,
  openTask: OpenTask,
) {
  let cursor = from;
  for (const node of nodes) {
    if (node.from < from || node.to > to) continue;
    parent.append(document.createTextNode(state.sliceDoc(cursor, node.from)));
    if (node.name === "Link" || node.name === "Image") {
      const parts = linkParts(state, node, references);
      const link = linkElement(parts.href, openTask);
      appendInline(
        link,
        state,
        children(node),
        parts.from,
        parts.to,
        references,
        openTask,
      );
      parent.append(link);
    } else if (inlineTags[node.name]) {
      const element = document.createElement(inlineTags[node.name]);
      appendInline(
        element,
        state,
        children(node),
        node.from,
        node.to,
        references,
        openTask,
      );
      parent.append(element);
    } else if (node.name === "Escape")
      parent.append(
        document.createTextNode(state.sliceDoc(node.from + 1, node.to)),
      );
    else if (node.name === "Entity") {
      const decoder = document.createElement("textarea");
      decoder.innerHTML = state.sliceDoc(node.from, node.to);
      parent.append(document.createTextNode(decoder.value));
    } else if (!marks.has(node.name) && node.name !== "HTMLTag")
      parent.append(
        document.createTextNode(state.sliceDoc(node.from, node.to)),
      );
    cursor = node.to;
  }
  parent.append(document.createTextNode(state.sliceDoc(cursor, to)));
}
class SymbolWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
  ) {
    super();
  }
  eq(other: SymbolWidget) {
    return this.text === other.text && this.className === other.className;
  }
  toDOM() {
    const element = document.createElement("span");
    element.className = this.className;
    element.textContent = this.text;
    element.setAttribute("aria-hidden", "true");
    return element;
  }
  ignoreEvent() {
    return false;
  }
}
class LinkWidget extends WidgetType {
  readonly parts;
  constructor(
    readonly state: EditorState,
    readonly node: SyntaxNode,
    readonly references: References,
    readonly openTask: OpenTask,
  ) {
    super();
    this.parts = linkParts(state, node, references);
  }
  eq(other: LinkWidget) {
    return (
      this.parts.href === other.parts.href &&
      this.parts.label === other.parts.label &&
      this.node.name === other.node.name
    );
  }
  toDOM() {
    const element = linkElement(this.parts.href, this.openTask);
    appendInline(
      element,
      this.state,
      children(this.node),
      this.parts.from,
      this.parts.to,
      this.references,
      this.openTask,
    );
    if (!element.textContent)
      element.textContent =
        this.node.name === "Image" ? "画像を開く" : this.parts.href;
    return element;
  }
  ignoreEvent() {
    return true;
  }
}
class TableRowWidget extends WidgetType {
  constructor(
    readonly state: EditorState,
    readonly node: SyntaxNode,
    readonly references: References,
    readonly openTask: OpenTask,
  ) {
    super();
  }
  toDOM(view: EditorView) {
    const row = document.createElement("span");
    row.className = `cm-md-table-row ${this.node.name === "TableHeader" ? "cm-md-table-header" : ""}`;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "表の行");
    const cells = this.node.getChildren("TableCell");
    const columns =
      this.node.parent?.getChild("TableHeader")?.getChildren("TableCell")
        .length || cells.length;
    row.style.gridTemplateColumns = `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`;
    for (let i = 0; i < columns; i++) {
      const cell = cells[i],
        element = document.createElement("span");
      element.className = "cm-md-table-cell";
      if (cell)
        appendInline(
          element,
          this.state,
          children(cell),
          cell.from,
          cell.to,
          this.references,
          this.openTask,
        );
      element.addEventListener("mousedown", (event) => {
        if ((event.target as Element).closest("a")) return;
        event.preventDefault();
        view.dispatch({ selection: { anchor: cell?.from ?? this.node.from } });
        view.focus();
      });
      row.append(element);
    }
    return row;
  }
  ignoreEvent() {
    return true;
  }
}

/** Decorations never alter the Markdown document. Every selected source line stays literal. */
export function minutesDecorations(
  state: EditorState,
  openTask: OpenTask,
): DecorationSet {
  const active = new Set<number>();
  for (const range of state.selection.ranges)
    for (
      let line = state.doc.lineAt(range.from).number;
      line <= state.doc.lineAt(range.to).number;
      line++
    )
      active.add(line);
  const decorations: Range<Decoration>[] = [];
  const references: References = new Map();
  const tree = syntaxTree(state);
  tree.iterate({
    enter({ node, name }) {
      if (name !== "LinkReference") return;
      const label = node.getChild("LinkLabel"),
        url = node.getChild("URL");
      if (label && url)
        references.set(
          normalizeLabel(state.sliceDoc(label.from, label.to)),
          state.sliceDoc(url.from, url.to),
        );
    },
  });
  const lineClasses = new Map<number, Set<string>>();
  const styleLine = (number: number, className: string) => {
    if (active.has(number)) return;
    const classes = lineClasses.get(number) ?? new Set<string>();
    classes.add(className);
    lineClasses.set(number, classes);
  };
  const inactive = (from: number, to: number) => {
    for (
      let line = state.doc.lineAt(from).number;
      line <= state.doc.lineAt(Math.max(from, to - 1)).number;
      line++
    )
      if (active.has(line)) return false;
    return true;
  };
  const hide = (from: number, to: number, widget?: WidgetType) => {
    if (to > from && inactive(from, to))
      decorations.push(Decoration.replace({ widget }).range(from, to));
  };
  const mark = (from: number, to: number, className: string) => {
    for (
      let number = state.doc.lineAt(from).number;
      number <= state.doc.lineAt(Math.max(from, to - 1)).number;
      number++
    ) {
      const line = state.doc.line(number),
        start = Math.max(from, line.from),
        end = Math.min(to, line.to);
      if (!active.has(number) && end > start)
        decorations.push(
          Decoration.mark({ class: className }).range(start, end),
        );
    }
  };
  tree.iterate({
    enter({ node, name, from, to }) {
      const line = state.doc.lineAt(from);
      if (/^ATXHeading|^SetextHeading/.test(name))
        styleLine(line.number, `cm-md-heading cm-md-h${name.at(-1)}`);
      if (name === "HeaderMark" || name === "QuoteMark") {
        hide(from, to + (state.sliceDoc(to, to + 1) === " " ? 1 : 0));
        if (name === "QuoteMark") styleLine(line.number, "cm-md-quote");
      } else if (name === "ListMark") {
        const text = state.sliceDoc(from, to);
        const task = node.parent?.getChild("Task");
        hide(
          from,
          to,
          task
            ? undefined
            : new SymbolWidget(/^\d/.test(text) ? text : "•", "cm-md-bullet"),
        );
      } else if (name === "TaskMarker")
        hide(
          from,
          to,
          new SymbolWidget(
            /x/i.test(state.sliceDoc(from, to)) ? "☑" : "☐",
            "cm-md-checkbox",
          ),
        );
      else if (name === "StrongEmphasis") mark(from, to, "cm-md-strong");
      else if (name === "Emphasis") mark(from, to, "cm-md-emphasis");
      else if (name === "Strikethrough") mark(from, to, "cm-md-strike");
      else if (name === "InlineCode") mark(from, to, "cm-md-inline-code");
      else if (name === "CodeText" || name === "CodeBlock") {
        for (
          let number = line.number;
          number <= state.doc.lineAt(to).number;
          number++
        )
          styleLine(number, "cm-md-code");
      } else if (
        name === "CodeInfo" ||
        (marks.has(name) && name !== "LinkMark")
      ) {
        hide(from, to);
        if (name === "CodeMark" && node.parent?.name === "FencedCode")
          styleLine(line.number, "cm-md-fence");
      } else if (
        (name === "Link" || name === "Image" || name === "Autolink") &&
        inactive(from, to) &&
        line.number === state.doc.lineAt(to).number
      ) {
        const widget = new LinkWidget(state, node, references, openTask);
        if (widget.parts.href || node.getChild("URL")) {
          hide(from, to, widget);
          return false;
        }
      } else if (
        (name === "TableHeader" || name === "TableRow") &&
        inactive(from, to)
      ) {
        hide(from, to, new TableRowWidget(state, node, references, openTask));
        styleLine(line.number, "cm-md-table-line");
        return false;
      } else if (name === "TableDelimiter" && node.parent?.name === "Table") {
        hide(from, to);
        styleLine(line.number, "cm-md-table-separator");
      } else if (name === "HorizontalRule")
        hide(from, to, new SymbolWidget("", "cm-md-rule"));
      else if (name === "HTMLBlock" || name === "HTMLTag") {
        // HTML is never interpreted, including while editing.
        for (
          let number = line.number;
          number <= state.doc.lineAt(to).number;
          number++
        ) {
          const part = state.doc.line(number);
          hide(Math.max(from, part.from), Math.min(to, part.to));
        }
        return false;
      }
    },
  });
  for (const number of active)
    decorations.push(
      Decoration.line({
        class: "cm-md-source",
        attributes: { "data-source-line": String(number) },
      }).range(state.doc.line(number).from),
    );
  for (const [number, classes] of lineClasses)
    decorations.push(
      Decoration.line({ class: [...classes].join(" ") }).range(
        state.doc.line(number).from,
      ),
    );
  return Decoration.set(decorations, true);
}
export function minutesLivePreview(openTask: OpenTask) {
  return StateField.define<DecorationSet>({
    create: (state) => minutesDecorations(state, openTask),
    update: (value, transaction) =>
      transaction.docChanged ||
      transaction.selection ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
        ? minutesDecorations(transaction.state, openTask)
        : value,
    provide: (field) => EditorView.decorations.from(field),
  });
}
