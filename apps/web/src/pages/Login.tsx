// SPDX-License-Identifier: MIT
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { api } from "../api/client";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setPending(true);
    try {
      await api.post("/auth/login", { username, password });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
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
            <h1 className="font-display text-lg font-bold uppercase tracking-[0.05em] text-ink">MediaNexus</h1>
            <p className="text-xs text-ink-dim">Sign in to continue</p>
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
          autoComplete="current-password"
          className="mb-4 w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
        />

        {error && <p className="mb-3 text-xs text-err">{error}</p>}

        <button
          type="submit"
          disabled={pending || !username || !password}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
        >
          <KeyRound className="h-3.5 w-3.5" /> {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
