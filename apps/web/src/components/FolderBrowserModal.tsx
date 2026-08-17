// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import { ArrowUp, FolderOpen } from "lucide-react";
import { api } from "../api/client";
import { Modal } from "./Modal";

interface FilesystemDirectory { name: string; path: string }
interface FilesystemListing { path: string; parent: string | null; directories: FilesystemDirectory[] }

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

/**
 * UNI-012 — reusable filesystem browser modal (built on the shared `Modal`). A live-editable
 * path input at top driving a type-ahead dropdown, plus a persistent click-to-descend directory
 * table below (an "Up" row when not at the real root). The dropdown and the table share the SAME
 * fetched GET /system/filesystem listing (the backend walks up to the nearest readable ancestor,
 * so a partially-typed path never dead-ends). Select commits whatever is currently in the input
 * — no existence validation, matching upstream (you can pick a not-yet-created folder).
 */
export function FolderBrowserModal({
  initial,
  onSelect,
  onClose,
}: {
  initial: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initial || "/");
  const [listing, setListing] = useState<FilesystemListing | null>(null);
  const [error, setError] = useState(false);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = (p: string) => {
    if (timer.current) clearTimeout(timer.current);
    // Keep the last listing until the fresh one lands (don't blank the whole browser on a
    // keystroke), and surface a fetch failure explicitly rather than swallowing it — an empty
    // list must never be confused with "this folder has no subdirectories".
    timer.current = setTimeout(() => {
      api.get<FilesystemListing>(`/system/filesystem?path=${encodeURIComponent(p)}`)
        .then((l) => { setListing(l); setError(false); })
        .catch(() => setError(true));
    }, 250);
  };

  useEffect(() => {
    load(path);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [path]);

  const descend = (p: string) => setPath(p);

  return (
    <Modal
      title="Browse folders"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
          <button onClick={() => { onSelect(path); onClose(); }} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">Select</button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <div className="relative">
          <input
            value={path}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/"
            autoFocus
            className={inputCls}
          />
          {focused && listing && listing.directories.length > 0 && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-rule bg-surface shadow-xl">
              {listing.directories.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); descend(d.path); }}
                  className="flex w-full items-center gap-2 truncate px-3 py-1.5 text-left text-sm font-mono text-ink hover:bg-rule"
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-dim" />
                  <span className="truncate">{d.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-rule">
              {listing?.parent != null && (
                <tr>
                  <td><button onClick={() => descend(listing.parent!)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-dim hover:bg-bg"><ArrowUp className="h-3.5 w-3.5" /> Up</button></td>
                </tr>
              )}
              {(listing?.directories ?? []).map((d) => (
                <tr key={d.path}>
                  <td>
                    <button onClick={() => descend(d.path)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg">
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-dim" />
                      <span className="truncate font-mono text-xs text-ink">{d.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error ? (
            <p className="px-3 py-2 text-sm text-err">Couldn&apos;t load this folder.</p>
          ) : listing && listing.directories.length === 0 ? (
            <p className="px-3 py-2 text-sm text-ink-dim">No subdirectories.</p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
