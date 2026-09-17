import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";

const configSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export async function readGlobalConfig(path: string): Promise<{ enabled: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { enabled: false };
    throw new Error("Jev: cannot read global jev.json");
  }
  let value: JsonValue;
  try {
    // SAFETY: JSON.parse returns JSON data, and configSchema validates its complete runtime shape below.
    value = JSON.parse(text) as JsonValue;
  } catch {
    throw new Error("Jev: global jev.json is not valid JSON");
  }
  if (!Check(configSchema, value)) throw new Error("Jev: global jev.json must contain only an enabled boolean");
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
