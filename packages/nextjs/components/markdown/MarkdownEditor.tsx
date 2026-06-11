"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import "@uiw/react-md-editor/markdown-editor.css";
import { MarkdownView } from "~~/components/markdown/MarkdownView";

// MDEditor touches the DOM (window/navigator) at import time, so it must never be
// server-rendered. dynamic(..., { ssr: false }) is only valid inside a "use client"
// module — this file is one. This is also the known-good pattern for the static
// export (`output: "export"`): the editor chrome is mounted client-side only.
const MDEditor = dynamic(() => import("@uiw/react-md-editor"), { ssr: false });

/**
 * Controlled markdown editor: textarea + toolbar from @uiw/react-md-editor on the
 * left, live preview rendered by OUR sanitizing MarkdownView on the right.
 *
 * We render MDEditor with preview="edit" so its own renderer/sanitizer is never
 * used — MarkdownView stays the single XSS render boundary. This component is
 * purely presentational: no contract calls, no upload logic.
 */
export function MarkdownEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [colorMode, setColorMode] = useState<"light" | "dark">("light");

  useEffect(() => {
    // v1: read the active daisyUI theme once on mount. This does NOT live-update
    // when the user toggles the theme after mount — acceptable for v1; revisit
    // with a MutationObserver on data-theme if live theme switching is needed.
    setColorMode(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  }, []);

  return (
    <div className="efs-md-editor flex flex-col lg:flex-row gap-4" data-color-mode={colorMode}>
      {/* Editor column */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-base-content/50 px-0.5">Editor</div>
        <div className="border border-base-300 rounded-lg overflow-hidden">
          <MDEditor value={value} onChange={v => onChange(v ?? "")} preview="edit" height={420} />
        </div>
      </div>
      {/* Preview column */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-base-content/50 px-0.5">Preview</div>
        <div className="border border-base-300 rounded-lg overflow-y-auto bg-base-100" style={{ height: 420 }}>
          {/* No extra prose wrapper: MarkdownView already renders its own
              <article className="prose prose-efs">. Wrapping again would nest prose. */}
          <div className="p-4">
            <MarkdownView source={value} />
          </div>
        </div>
      </div>
    </div>
  );
}
