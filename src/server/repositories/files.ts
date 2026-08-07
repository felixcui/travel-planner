import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Place, TripBundle } from "@/lib/domain";
import { PlaceSchema, TripBundleSchema } from "@/lib/domain";

const root = resolve(/* turbopackIgnore: true */ process.cwd(), process.env.DATA_DIR ?? "./data");
const stableHash = (value: string) => createHash("sha256").update(value).digest("hex");

async function atomicWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class FilePlaceRepository {
  private dir = join(root, "places");

  async findByName(name: string) {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const raw = await readJson<Place>(join(this.dir, file));
      const parsed = PlaceSchema.safeParse(raw);
      if (parsed.success && [parsed.data.name, ...parsed.data.aliases].some((candidate) => candidate.toLowerCase() === name.toLowerCase())) return parsed.data;
    }
    return null;
  }

  async list() {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((file) => file.endsWith(".json"));
    const places = await Promise.all(files.map((file) => readJson<Place>(join(this.dir, file))));
    return places.map((place) => PlaceSchema.safeParse(place)).filter((result) => result.success).map((result) => result.data);
  }

  async save(place: Place) {
    const validated = PlaceSchema.parse(place);
    await atomicWrite(join(this.dir, `${validated.id}.json`), validated);
    return validated;
  }
}

export class FileTripRepository {
  private dir = join(root, "trips");
  async save(bundle: TripBundle) {
    const validated = TripBundleSchema.parse(bundle);
    await atomicWrite(join(this.dir, `${validated.id}.json`), validated);
    return validated;
  }
  async get(id: string) {
    const data = await readJson<TripBundle>(join(this.dir, `${id}.json`));
    const parsed = TripBundleSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  }
}

export class FileShareRepository {
  private dir = join(root, "shares");
  async save(token: string, bundle: TripBundle) {
    const hash = stableHash(token);
    await atomicWrite(join(this.dir, `${hash}.json`), { schemaVersion: 1, createdAt: new Date().toISOString(), bundle: TripBundleSchema.parse(bundle) });
  }
  async get(token: string) {
    const data = await readJson<{ bundle: TripBundle }>(join(this.dir, `${stableHash(token)}.json`));
    const parsed = TripBundleSchema.safeParse(data?.bundle);
    return parsed.success ? parsed.data : null;
  }
}

export const dataRoot = root;
