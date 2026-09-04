import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { get as getBlob, list as listBlobs, put as putBlob } from "@vercel/blob";
import type { AgentSession, Place, TripBundle } from "@/lib/domain";
import { AgentSessionSchema, migrateTripBundle, PlaceSchema, TripBundleSchema } from "@/lib/domain";
import { getLockPath, withLock } from "./file-lock";

// Vercel Functions 的 /tmp 不跨实例共享，因此生产环境必须使用已连接的
// Private Vercel Blob。非 Vercel 环境继续使用本地 data 目录。
const isVercel = process.env.VERCEL === "1";
const root = resolve(/* turbopackIgnore: true */ process.cwd(), process.env.DATA_DIR ?? "./data");
const blobPrefix = (process.env.BLOB_DATA_PREFIX ?? "travel-planner").replace(/^\/+|\/+$/g, "");
const stableHash = (value: string) => createHash("sha256").update(value).digest("hex");

type Collection = "places" | "trips" | "agent-sessions" | "shares";

function assertBlobConfigured() {
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Vercel Blob 未连接：请为项目配置 Private Blob Store");
  }
}

function storagePath(collection: Collection, filename: string) {
  return `${blobPrefix}/${collection}/${filename}`;
}

async function atomicWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, path);
}

async function atomicWriteWithLock(path: string, value: unknown) {
  const lockPath = getLockPath(dirname(path), basename(path));
  await withLock(lockPath, async () => {
    await atomicWrite(path, value);
  });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveJson(collection: Collection, filename: string, value: unknown) {
  if (!isVercel) {
    await atomicWriteWithLock(join(root, collection, filename), value);
    return;
  }
  assertBlobConfigured();
  await putBlob(storagePath(collection, filename), JSON.stringify(value), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
  });
}

async function loadJson<T>(collection: Collection, filename: string): Promise<T | null> {
  if (!isVercel) return readJson<T>(join(root, collection, filename));
  assertBlobConfigured();
  const result = await getBlob(storagePath(collection, filename), { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  return JSON.parse(await new Response(result.stream).text()) as T;
}

async function listJson<T>(collection: Collection): Promise<Array<T | null>> {
  if (!isVercel) {
    const dir = join(root, collection);
    await mkdir(dir, { recursive: true });
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<T>(join(dir, file))));
  }
  assertBlobConfigured();
  const prefix = `${storagePath(collection, "")}`;
  const pathnames: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listBlobs({ prefix, cursor, limit: 1000 });
    pathnames.push(...page.blobs.filter((blob) => blob.pathname.endsWith(".json")).map((blob) => blob.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return Promise.all(pathnames.map(async (pathname) => {
    const result = await getBlob(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return JSON.parse(await new Response(result.stream).text()) as T;
  }));
}

export class FilePlaceRepository {
  async findByName(name: string) {
    const places = await listJson<Place>("places");
    for (const raw of places) {
      const parsed = PlaceSchema.safeParse(raw);
      if (parsed.success && [parsed.data.name, ...parsed.data.aliases].some((candidate) => candidate.toLowerCase() === name.toLowerCase())) return parsed.data;
    }
    return null;
  }

  async list() {
    const places = await listJson<Place>("places");
    return places.map((place) => PlaceSchema.safeParse(place)).filter((result) => result.success).map((result) => result.data);
  }

  async save(place: Place) {
    const validated = PlaceSchema.parse(place);
    await saveJson("places", `${validated.id}.json`, validated);
    return validated;
  }
}

export class FileTripRepository {
  async save(bundle: TripBundle) {
    const validated = TripBundleSchema.parse(bundle);
    await saveJson("trips", `${validated.id}.json`, validated);
    return validated;
  }
  async get(id: string) {
    const data = await loadJson<unknown>("trips", `${id}.json`);
    if (!data) return null;
    try { return migrateTripBundle(data); } catch { return null; }
  }
  async list() {
    const bundles = await listJson<unknown>("trips");
    return bundles
      .map((bundle) => { try { return migrateTripBundle(bundle); } catch { return null; } })
      .filter((bundle): bundle is TripBundle => Boolean(bundle))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

export class FileAgentSessionRepository {
  async save(session: AgentSession) {
    const validated = AgentSessionSchema.parse(session);
    await saveJson("agent-sessions", `${validated.id}.json`, validated);
    return validated;
  }

  async get(id: string) {
    const data = await loadJson<unknown>("agent-sessions", `${id}.json`);
    const parsed = AgentSessionSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  }
}

export class FileShareRepository {
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
    await saveJson("shares", `${hash}.json`, { schemaVersion: 2, createdAt: new Date().toISOString(), bundle: shared });
  }
  async get(token: string) {
    const data = await loadJson<{ bundle?: unknown }>("shares", `${stableHash(token)}.json`);
    if (!data?.bundle) return null;
    try { return migrateTripBundle(data.bundle); } catch { return null; }
  }
}

export const dataRoot = root;
