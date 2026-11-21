// Calls to the playground API. Same origin, JSON only; the server refuses other hosts and origins.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
