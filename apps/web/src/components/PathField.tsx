// SPDX-License-Identifier: MIT
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { FolderBrowserModal } from "./FolderBrowserModal";

const inputCls = "min-w-0 flex-1 rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

/**
 * UNI-012 — drop-in replacement for a hand-typed path `<input className={monoCls}/>`: the same
 * mono text input (still directly editable by hand — browsing is an aid, not the only way to set
 * a path) plus a folder-icon browse button that opens `FolderBrowserModal`. Wherever a path
 * field exists, swap the raw input for `<PathField value onChange placeholder/>` and the picker
 * comes for free.
 */
export function PathField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputCls}
      />
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Browse filesystem"
        aria-label="Browse filesystem"
        className="shrink-0 rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink"
      >
        <FolderOpen className="h-4 w-4" />
      </button>
      {open && (
        <FolderBrowserModal
          initial={value}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
