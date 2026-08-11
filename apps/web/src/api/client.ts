// SPDX-License-Identifier: MIT
export const API_BASE = (import.meta.env.VITE_MEDIA_NEXUS_API_URL as string | undefined) ?? "/api/v1";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401 && !window.location.hash.startsWith("#/login") && !window.location.hash.startsWith("#/setup")) {
    window.location.hash = "#/login";
  }
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiClientError(res.status, err?.code ?? "INTERNAL", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return body as T;
}

const headers = { "Content-Type": "application/json" };

export const api = {
  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    return handle<T>(res);
  },
  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return handle<T>(res);
  },
  async put<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, { method: "PUT", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return handle<T>(res);
  },
  async del<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers });
    return handle<T>(res);
  },
};
