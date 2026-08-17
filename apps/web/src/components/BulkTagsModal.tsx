// SPDX-License-Identifier: MIT
// BulkTagsModal — UNI-020 "Set Tags" bulk toolbar action. A mode toggle (Add/Remove/Replace)
// plus the existing TagPicker (reused unchanged from UNI-017b — not a new tag input). Add =
// union, Remove = set-difference, Replace = overwrite (picking nothing + Replace clears).
import { useState } from "react";
import { Modal } from "./Modal";
import { TagPicker } from "./TagPicker";

const inputCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const labelCls = "mb-1 block text-xs text-ink-dim";

export function BulkTagsModal({
  onSave,
  onClose,
  busy,
}: {
  onSave: (tagIds: string[], mode: "add" | "remove" | "replace") => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [mode, setMode] = useState<"add" | "remove" | "replace">("add");
  const [tags, setTags] = useState<string[]>([]);

  return (
    <Modal
      title="Set Tags"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
          <button onClick={() => onSave(tags, mode)} disabled={busy} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <label className="block">
          <span className={labelCls}>Action</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as "add" | "remove" | "replace")} className={inputCls}>
            <option value="add">Add</option>
            <option value="remove">Remove</option>
            <option value="replace">Replace</option>
          </select>
        </label>
        <div>
          <span className={labelCls}>Tags{mode === "replace" ? " (Replace with none clears all)" : ""}</span>
          <TagPicker value={tags} onChange={setTags} />
        </div>
      </div>
    </Modal>
  );
}
