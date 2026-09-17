import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { buildRequest, type DecisionInput, type JsonValue, parseDecision } from "./decision.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 32_768;

export async function readApiKey(envFile: string): Promise<string> {
  const supplied = process.env.TYPESAFE_API_KEY?.trim();
  if (supplied) return supplied;
  let contents: string;
  try {
    contents = await readFile(envFile, "utf8");
  } catch {
    throw new Error("Jev: TYPESAFE_API_KEY is unavailable in the environment or Pi .env");
  }
  const key = parseEnv(contents).TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error("Jev: TYPESAFE_API_KEY is missing from Pi .env");
  return key;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("Jev: empty API response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("Jev: API response exceeded 32 KiB");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function evaluate(input: DecisionInput, key: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const body = JSON.stringify(buildRequest(input));
  if (!key.trim()) throw new Error("Jev: missing API key");
  if (body.includes(key)) throw new Error("Jev: input contains the API credential; remove it before retrying");
  if (Buffer.byteLength(body) > 65_536) throw new Error("Jev: request exceeded 64 KiB");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const started = performance.now();
  let response: Response;
  let text: string;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get("retry-after");
      const wait = retry && /^\d{1,6}$/.test(retry) ? ` Retry after ${retry}s.` : "";
      throw new Error(`Jev: HTTP ${response.status}; no decision accepted.${wait}`);
    }
    text = await readBoundedBody(response);
  } catch (error) {
    if (signal?.aborted) throw new Error("Jev: request cancelled; no decision accepted");
    if (timeout.aborted) throw new Error("Jev: 15s request deadline exceeded; no automatic retry");
    if (error instanceof Error && error.message.startsWith("Jev:")) throw error;
    throw new Error("Jev: network or response-stream failure; no decision accepted");
  }
  let raw: JsonValue;
  try {
    // SAFETY: JSON.parse returns JSON data, and parseDecision validates the complete response schema.
    raw = JSON.parse(text) as JsonValue;
  } catch {
    throw new Error("Jev: response is not JSON; no decision accepted");
  }
  return { ...parseDecision(raw, input), elapsedMs: Math.round(performance.now() - started), cost: "not reported by API" };
}
