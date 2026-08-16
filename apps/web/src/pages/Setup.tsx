// SPDX-License-Identifier: MIT
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { api } from "../api/client";

export default function Setup() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setPending(true);
    try {
      await api.post("/auth/setup", { username, password });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-rule bg-surface p-6">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent font-display text-lg font-bold text-accent-ink">M</div>
          <div>
            <h1 className="font-display text-lg font-bold uppercase tracking-[0.05em] text-ink">Welcome to MediaNexus</h1>
            <p className="text-xs text-ink-dim">Create your account to get started</p>
          </div>
        </div>

        <label className="mb-1 block text-xs text-ink-dim">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          className="mb-3 w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
        />

        <label className="mb-1 block text-xs text-ink-dim">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className="mb-3 w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
        />

        <label className="mb-1 block text-xs text-ink-dim">Confirm password</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className="mb-4 w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
        />

        {error && <p className="mb-3 text-xs text-err">{error}</p>}

        <button
          type="submit"
          disabled={pending || !username || !password || !confirm}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
        >
          <KeyRound className="h-3.5 w-3.5" /> {pending ? "Creating account…" : "Create account"}
        </button>

        <p className="mt-4 text-xs text-ink-dim">
          This is a single-operator app — one account, no email, no reset link. If you lose this password later, an
          operator can delete the admin credential from the database to restart setup (see docs/security.md).
        </p>
      </form>
    </div>
  );
}
