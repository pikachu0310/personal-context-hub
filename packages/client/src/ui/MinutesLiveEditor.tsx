import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  MAX_MINUTES_LENGTH,
  type TaskReference,
} from "@ido/common/contracts/api";
import { minutesLivePreview } from "./minutes-live-preview.js";
export interface MinutesEditorHandle {
  selection(): { from: number; to: number };
  insert(from: number, to: number, text: string): void;
  focus(): void;
}
export const MinutesLiveEditor = forwardRef<
  MinutesEditorHandle,
  {
    value: string;
    disabled: boolean;
    change: (value: string) => void;
    openTask: (reference: TaskReference) => void;
  }
>(function MinutesLiveEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const editable = useRef(new Compartment());
  const permissions = (disabled: boolean) => [
    EditorState.readOnly.of(disabled),
    EditorView.editable.of(!disabled),
  ];
  useImperativeHandle(
    ref,
    () => ({
      selection: () => {
        const range = editor.current?.state.selection.main;
        return { from: range?.from ?? 0, to: range?.to ?? 0 };
      },
      insert: (from, to, text) => {
        const view = editor.current;
        if (!view || latest.current.disabled) return;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
          annotations: [
            Transaction.userEvent.of("input"),
            isolateHistory.of("full"),
          ],
        });
      },
      focus: () => editor.current?.focus(),
    }),
    [],
  );
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          editable.current.of(permissions(latest.current.disabled)),
          EditorView.contentAttributes.of({
            "aria-label": "議事録のMarkdown",
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorState.transactionFilter.of((transaction) =>
            transaction.newDoc.length > MAX_MINUTES_LENGTH &&
            transaction.docChanged
              ? []
              : transaction,
          ),
          minutesLivePreview((reference) => latest.current.openTask(reference)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              latest.current.change(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    view.focus();
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== props.value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.value },
        annotations: Transaction.addToHistory.of(false),
      });
  }, [props.value]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: editable.current.reconfigure(permissions(props.disabled)),
    });
  }, [props.disabled]);
  return <div className="minutes-live-editor" ref={host} />;
});
