import fs from "fs/promises";
import path from "path";

const LOCK_TIMEOUT_MS = 5_000;
// Venue scans can outlive a slow upstream request, so do not steal a live lock early.
const STALE_LOCK_MS = 5 * 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  const lockFile = `${file}.lock`;
  const started = Date.now();
  await fs.mkdir(path.dirname(file), { recursive: true });
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const handle = await fs.open(lockFile, "wx");
      return async () => {
        await handle.close();
        await fs.unlink(lockFile).catch(() => undefined);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const stat = await fs.stat(lockFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.unlink(lockFile).catch(() => undefined);
      } else {
        await delay(20);
      }
    }
  }
  throw new Error(`Timed out acquiring lock for ${file}`);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf-8");
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function mutateJson<T, R>(
  file: string,
  fallback: T,
  mutate: (current: T) => { value: T; result: R }
): Promise<R> {
  const release = await acquireLock(file);
  try {
    const current = await readJson(file, fallback);
    const next = mutate(current);
    await writeJsonAtomic(file, next.value);
    return next.result;
  } finally {
    await release();
  }
}

export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const release = await acquireLock(file);
  try {
    return await work();
  } finally {
    await release();
  }
}
