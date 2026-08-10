// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X, Plus, Bookmark, Ban } from "lucide-react";
import { api } from "../api/client";
import type { RequestRow, Paged, Movie, Series } from "../api/types";
import { Badge, EmptyState, ErrorState, formatDate, statusTone } from "../lib/ui";

export default function Requests() {
  const qc = useQueryClient();
  const [mediaType, setMediaType] = useState<"movie" | "series">("movie");
  const [mediaId, setMediaId] = useState("");

  const requests = useQuery({ queryKey: ["requests"], queryFn: () => api.get<RequestRow[]>("/requests") });
  const movies = useQuery({ queryKey: ["movies"], queryFn: () => api.get<Paged<Movie>>("/movies?pageSize=100") });
  const series = useQuery({ queryKey: ["series"], queryFn: () => api.get<Paged<Series>>("/series?pageSize=100") });

  const create = useMutation({
    mutationFn: (body: { mediaType: "movie" | "series"; mediaId: string }) => api.post<RequestRow>("/requests", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["requests"] }); setMediaId(""); },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "approved" | "declined" }) => api.post(`/requests/${id}/${status}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["requests"] }),
  });

  const watch = useMutation({
    mutationFn: (r: RequestRow) => api.post("/watchlist", { mediaType: r.mediaType, mediaId: r.mediaId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["requests"] }),
  });
  const block = useMutation({
    mutationFn: (r: RequestRow) => api.post("/content-blocklist", { mediaType: r.mediaType, mediaId: r.mediaId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["requests"] }),
  });

  const options = mediaType === "movie" ? (movies.data?.items ?? []) : (series.data?.items ?? []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Requests</h2>
        <p className="text-sm text-zinc-500">Request → approval → auto-search pipeline (Seerr-parity foundation).</p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
        onSubmit={(e) => { e.preventDefault(); if (mediaId) create.mutate({ mediaType, mediaId }); }}>
        <label>
          <span className="mb-1 block text-xs text-zinc-500">Type</span>
          <select value={mediaType} onChange={(e) => { setMediaType(e.target.value as "movie" | "series"); setMediaId(""); }}
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700">
            <option value="movie">Movie</option><option value="series">Series</option>
          </select>
        </label>
        <label className="min-w-56 flex-1">
          <span className="mb-1 block text-xs text-zinc-500">Library title</span>
          <select required value={mediaId} onChange={(e) => setMediaId(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700 dark:bg-zinc-900">
            <option value="">Select…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{"title" in o ? o.title : ""}</option>)}
          </select>
        </label>
        <button disabled={create.isPending} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          <Plus className="h-4 w-4" /> {create.isPending ? "Requesting…" : "Request"}
        </button>
        {create.isError && <p className="text-xs text-red-600">{create.error instanceof Error ? create.error.message : "Failed"}</p>}
      </form>

      {requests.isError ? <ErrorState error={requests.error} onRetry={() => requests.refetch()} /> : requests.data?.length === 0 ? (
        <EmptyState title="No requests yet" hint="Admin requests auto-approve and trigger a search job." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr><th className="px-4 py-2.5">Title</th><th className="px-4 py-2.5">Type</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Requested</th><th className="px-4 py-2.5 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {requests.data?.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                  <td className="px-4 py-2.5 font-medium">{r.mediaTitle ?? r.mediaId}</td>
                  <td className="px-4 py-2.5 text-zinc-500 capitalize">{r.mediaType}</td>
                  <td className="px-4 py-2.5"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                  <td className="px-4 py-2.5 text-zinc-500">{formatDate(r.requestedAt)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => watch.mutate(r)} className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Add to watchlist"><Bookmark className="h-3.5 w-3.5" /></button>
                      <button onClick={() => block.mutate(r)} className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950" title="Block content"><Ban className="h-3.5 w-3.5" /></button>
                      {r.status === "pending" && (
                        <>
                          <button onClick={() => setStatus.mutate({ id: r.id, status: "approved" })} className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"><Check className="h-3 w-3" /> Approve</button>
                          <button onClick={() => setStatus.mutate({ id: r.id, status: "declined" })} className="flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500"><X className="h-3 w-3" /> Decline</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
