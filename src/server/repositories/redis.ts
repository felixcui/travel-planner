import type { StorageBackend } from "./storage";

const url = process.env.UPSTASH_REDIS_REST_URL ?? "";
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
const prefix = "travel-planner";

function key(type: string, id: string) {
  return `${prefix}:${type}:${id}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T | null> {
  const response = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options?.headers ?? {}) },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Redis 请求失败 ${response.status}: ${text}`);
  }
  const body = (await response.json()) as { result?: T };
  return body.result ?? null;
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class RedisStorageBackend implements StorageBackend {
  async read(type: string, id: string): Promise<unknown | null> {
    const raw = await request<string>(`/get/${encodeURIComponent(key(type, id))}`);
    return decode(raw);
  }

  async write(type: string, id: string, value: unknown): Promise<void> {
    await request<string>(`/set/${encodeURIComponent(key(type, id))}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encode(value),
    });
  }

  async list(type: string): Promise<string[]> {
    const pattern = `${prefix}:${type}:*`;
    const keys = (await request<string[]>(`/keys/${encodeURIComponent(pattern)}`)) ?? [];
    const prefixWithType = `${prefix}:${type}:`;
    return keys.map((item) => item.replace(prefixWithType, ""));
  }
}
