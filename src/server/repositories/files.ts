import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentSession, Place, TripBundle } from "@/lib/domain";
import { AgentSessionSchema, migrateTripBundle, PlaceSchema, TripBundleSchema } from "@/lib/domain";
import { getLockPath, withLock } from "./file-lock";
import { RedisStorageBackend } from "./redis";
import type { StorageBackend } from "./storage";

// Vercel Serverless Functions 的运行时文件系统只读，唯一可写目录是 /tmp；
// 但 /tmp 在不同实例间不共享，session 会跨请求丢失。因此 Vercel 上优先用 Redis；
// 本地开发或没有 Redis 配置时仍使用项目目录下的 data 文件夹。
const root = process.env.VERCEL
  ? resolve("/tmp", process.env.DATA_DIR ?? "data")
  : resolve(/* turbopackIgnore: true */ process.cwd(), process.env.DATA_DIR ?? "./data");
const stableHash = (value: string) => createHash("sha256").update(value).digest("hex");

class FileStorageBackend implements StorageBackend {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private path(type: string, id: string) {
    return join(this.baseDir, type, `${id}.json`);
  }

  private dir(type: string) {
    return join(this.baseDir, type);
  }

  async read(type: string, id: string): Promise<unknown | null> {
    const path = this.path(type, id);
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(type: string, id: string, value: unknown): Promise<void> {
    const path = this.path(type, id);
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const lockPath = getLockPath(dir, basename(path));
    await withLock(lockPath, async () => {
      await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
      await rename(temp, path);
    });
  }

  async list(type: string): Promise<string[]> {
    const dir = this.dir(type);
    await mkdir(dir, { recursive: true });
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    return files.map((file) => file.replace(/\.json$/, ""));
  }
}

function createBackend(): StorageBackend {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new RedisStorageBackend();
  }
  return new FileStorageBackend(root);
}

export class FilePlaceRepository {
  private static readonly type = "places";
  private readonly backend = createBackend();

  async findByName(name: string) {
    const ids = await this.backend.list(FilePlaceRepository.type);
    for (const id of ids) {
      const raw = await this.backend.read(FilePlaceRepository.type, id);
      const parsed = PlaceSchema.safeParse(raw);
      if (parsed.success && [parsed.data.name, ...parsed.data.aliases].some((candidate) => candidate.toLowerCase() === name.toLowerCase())) return parsed.data;
    }
    return null;
  }

  async list() {
    const ids = await this.backend.list(FilePlaceRepository.type);
    const places = await Promise.all(ids.map((id) => this.backend.read(FilePlaceRepository.type, id)));
    return places.map((place) => PlaceSchema.safeParse(place)).filter((result) => result.success).map((result) => result.data);
  }

  async save(place: Place) {
    const validated = PlaceSchema.parse(place);
    await this.backend.write(FilePlaceRepository.type, validated.id, validated);
    return validated;
  }
}

export class FileTripRepository {
  private static readonly type = "trips";
  private readonly backend = createBackend();

  async save(bundle: TripBundle) {
    const validated = TripBundleSchema.parse(bundle);
    await this.backend.write(FileTripRepository.type, validated.id, validated);
    return validated;
  }
  async get(id: string) {
    const data = await this.backend.read(FileTripRepository.type, id);
    if (!data) return null;
    try { return migrateTripBundle(data); } catch { return null; }
  }
  async list() {
    const ids = await this.backend.list(FileTripRepository.type);
    const bundles = await Promise.all(ids.map((id) => this.backend.read(FileTripRepository.type, id)));
    return bundles
      .map((bundle) => { try { return migrateTripBundle(bundle); } catch { return null; } })
      .filter((bundle): bundle is TripBundle => Boolean(bundle))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

export class FileAgentSessionRepository {
  private static readonly type = "agent-sessions";
  private readonly backend = createBackend();

  async save(session: AgentSession) {
    const validated = AgentSessionSchema.parse(session);
    await this.backend.write(FileAgentSessionRepository.type, validated.id, validated);
    return validated;
  }

  async get(id: string) {
    const data = await this.backend.read(FileAgentSessionRepository.type, id);
    const parsed = AgentSessionSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  }
}

export class FileShareRepository {
  private static readonly type = "shares";
  private readonly backend = createBackend();

  async save(token: string, bundle: TripBundle) {
    const hash = stableHash(token);
    const validated = TripBundleSchema.parse(bundle);
    const selected = validated.plans.find((plan) => plan.id === validated.selectedPlanId) ?? validated.plans[0];
    const shared: TripBundle = {
      ...validated,
      plans: [selected],
      selectedPlanId: selected.id,
      agentSessionId: undefined,
      revisions: [],
    };
    await this.backend.write(FileShareRepository.type, hash, { schemaVersion: 2, createdAt: new Date().toISOString(), bundle: shared });
  }
  async get(token: string) {
    const data = await this.backend.read(FileShareRepository.type, stableHash(token)) as { bundle?: unknown } | null;
    if (!data?.bundle) return null;
    try { return migrateTripBundle(data.bundle); } catch { return null; }
  }
}

export const dataRoot = root;
