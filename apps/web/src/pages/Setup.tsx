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
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 font-bold text-white">M</div>
          <div>
            <h1 className="text-lg font-semibold">Welcome to MediaNexus</h1>
            <p className="text-xs text-zinc-500">Create your account to get started</p>
          </div>
        </div>

        <label className="mb-1 block text-xs text-zinc-500">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          className="mb-3 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700"
        />

        <label className="mb-1 block text-xs text-zinc-500">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className="mb-3 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700"
        />

        <label className="mb-1 block text-xs text-zinc-500">Confirm password</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className="mb-4 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700"
        />

        {error && <p className="mb-3 text-xs text-red-600 dark:text-red-500">{error}</p>}

        <button
          type="submit"
          disabled={pending || !username || !password || !confirm}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          <KeyRound className="h-3.5 w-3.5" /> {pending ? "Creating account…" : "Create account"}
        </button>

        <p className="mt-4 text-xs text-zinc-500">
          This is a single-operator app — one account, no email, no reset link. If you lose this password later, an
          operator can delete the admin credential from the database to restart setup (see docs/security.md).
        </p>
      </form>
    </div>
  );
}
