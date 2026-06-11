"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
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
    <div className="flex flex-col lg:flex-row gap-3" data-color-mode={colorMode}>
      <div className="flex-1 min-w-0">
        <MDEditor value={value} onChange={v => onChange(v ?? "")} preview="edit" height={360} />
      </div>
      <div className="flex-1 min-w-0 border border-base-300 rounded-lg overflow-y-auto" style={{ maxHeight: 380 }}>
        <div className="text-xs font-semibold text-base-content/60 px-3 py-2 border-b border-base-content/10">
          Preview
        </div>
        {/* No extra prose wrapper: MarkdownView already renders its own
            <article className="prose prose-efs">. Wrapping again would nest prose. */}
        <div className="p-3">
          <MarkdownView source={value} />
        </div>
      </div>
    </div>
  );
}
