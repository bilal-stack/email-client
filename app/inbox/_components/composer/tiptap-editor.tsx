"use client";

import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

interface TipTapEditorProps {
  initialContent: string;
  onUpdate: (html: string) => void;
}

/**
 * Locked-down TipTap configuration:
 *   - `StarterKit` (paragraph, headings, bold/italic, lists, code, blockquote)
 *   - `Link` (no auto-open on click — we don't want the editor to navigate)
 *   - `Placeholder`
 * Deliberately no Image extension — attachments go through the file input.
 *
 * `immediatelyRender: false` keeps the editor from hydrating on the server
 * (TipTap depends on a real DOM via ProseMirror). See spec.md risk #5.
 */
export function TipTapEditor({ initialContent, onUpdate }: TipTapEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      Placeholder.configure({ placeholder: "Write your message…" }),
    ],
    content: initialContent,
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => onUpdate(ed.getHTML()),
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none min-h-[200px] focus:outline-none px-3 py-2 text-sm text-zinc-900",
      },
    },
  });

  return (
    <div className="rounded-md border border-zinc-300 bg-white focus-within:ring-2 focus-within:ring-zinc-400">
      <EditorContent editor={editor} />
    </div>
  );
}
