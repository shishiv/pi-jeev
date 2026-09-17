import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readGlobalConfig(path: string): Promise<{ enabled: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { enabled: false };
    throw new Error("Jev: cannot read global jev.json");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Jev: global jev.json is not valid JSON"); }
  if (value === null || typeof value !== "object" || !("enabled" in value)
    || typeof value.enabled !== "boolean" || Object.keys(value).some((key) => key !== "enabled")) {
    throw new Error("Jev: global jev.json must contain only an enabled boolean");
  }
  return { enabled: value.enabled };
}

export async function writeGlobalConfig(path: string, enabled: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ enabled }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
