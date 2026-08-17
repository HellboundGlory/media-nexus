// SPDX-License-Identifier: MIT
// OptionsModal — UNI-029 pass 1 client-side display options for the library poster grid.
// Poster Size (drives the grid column breakpoints), Show Title, Show Quality Profile. All three
// persist via useAppStore (the same zustand-persist mechanism as the theme/view-mode toggles).
import { useAppStore } from "../store/useAppStore";
import { Modal } from "./Modal";

const labelCls = "mb-1 block text-xs text-ink-dim";
const selectCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function OptionsModal({ onClose }: { onClose: () => void }) {
  const posterSize = useAppStore((s) => s.posterSize);
  const setPosterSize = useAppStore((s) => s.setPosterSize);
  const showTitle = useAppStore((s) => s.showTitle);
  const setShowTitle = useAppStore((s) => s.setShowTitle);
  const showQualityProfile = useAppStore((s) => s.showQualityProfile);
  const setShowQualityProfile = useAppStore((s) => s.setShowQualityProfile);

  return (
    <Modal
      title="Options"
      onClose={onClose}
      footer={
        <button onClick={onClose} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">Done</button>
      }
    >
      <div className="space-y-4 p-4">
        <label className="block">
          <span className={labelCls}>Poster Size</span>
          <select value={posterSize} onChange={(e) => setPosterSize(e.target.value as "small" | "medium" | "large")} className={selectCls}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label className="flex items-center gap-2.5 text-sm text-ink">
          <input type="checkbox" checked={showTitle} onChange={(e) => setShowTitle(e.target.checked)} className="h-4 w-4 accent-accent" />
          Show Title
        </label>
        <label className="flex items-center gap-2.5 text-sm text-ink">
          <input type="checkbox" checked={showQualityProfile} onChange={(e) => setShowQualityProfile(e.target.checked)} className="h-4 w-4 accent-accent" />
          Show Quality Profile
        </label>
      </div>
    </Modal>
  );
}
