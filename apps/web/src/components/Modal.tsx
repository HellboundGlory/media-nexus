// SPDX-License-Identifier: MIT
// Modal — the shared real-overlay dialog shell (QUALITYPROFILES-1). This is the deliberate
// deviation from this app's otherwise-inline-form settings convention: Hellbound explicitly
// asked for upstream Sonarr/Radarr's real modal pattern for quality profiles, custom formats
// and the add/edit-title flows, so this component exists once and every modal in those flows
// reuses it (rather than each page growing its own `fixed inset-0` overlay).
import { type ReactNode } from "react";
import { clsx } from "clsx";
import { X } from "lucide-react";

export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Two-column / larger dialogs (quality profile editor). */
  wide?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-14" onClick={onClose}>
      <div
        className={clsx("my-auto w-full overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl", wide ? "max-w-4xl" : "max-w-lg")}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-rule px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
