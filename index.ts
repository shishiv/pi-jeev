import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluate, readApiKey } from "./client.ts";
import { decisionSchema } from "./decision.ts";
import { readGlobalConfig, writeGlobalConfig } from "./config.ts";

const TOOL = "jev_decide";

export default function jevExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const configFile = join(agentDir, "jev.json");
  let active = false;
  let requests = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing: Promise<void> | undefined;
  let stopped = false;
  let lastError: string | undefined;

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else if (level !== "info") console.error(message);
  }

  function setToolActive(enabled: boolean) {
    const tools = pi.getActiveTools();
    if (tools.includes(TOOL) === enabled) return;
    pi.setActiveTools(enabled ? [...tools, TOOL] : tools.filter((name) => name !== TOOL));
  }

  function applyMode(ctx: ExtensionContext, enabled: boolean) {
    if (active === enabled) return;
    active = enabled;
    setToolActive(enabled);
    if (!enabled) {
      requests.abort();
      requests = new AbortController();
    }
    if (ctx.hasUI) ctx.ui.setStatus("jev", enabled ? "Jev global · bounded judge" : undefined);
  }

  function synchronize(ctx: ExtensionContext, boundary = false): Promise<void> {
    if (stopped || (!boundary && !ctx.isIdle())) return Promise.resolve();
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const config = await readGlobalConfig(configFile);
        if (stopped || (!boundary && !ctx.isIdle())) return;
        if (config.enabled) await readApiKey(join(agentDir, ".env"));
        applyMode(ctx, config.enabled);
        lastError = undefined;
      } catch (error) {
        if (stopped) return;
        applyMode(ctx, false);
        const message = error instanceof Error ? error.message : "Jev: global configuration failed";
        if (message !== lastError) notify(ctx, message, "error");
        lastError = message;
      }
    })().finally(() => { syncing = undefined; });
    return syncing;
  }

  pi.registerTool({
    name: TOOL,
    label: "Jev bounded decision",
    description: "Judge one bounded semantic choice and return a recommendation, abstention, or required review",
    promptSnippet: "Judge one bounded semantic choice after deterministic rules leave multiple plausible options",
    promptGuidelines: [
      "Use jev_decide only after direct evidence and deterministic rules leave at least two materially plausible options whose difference requires semantic judgment.",
      "Do not use jev_decide for authorization, safety policy, arithmetic, exact lookup, known state transitions, or execution of an already selected action.",
      "Give jev_decide observed facts, explicit constraints, known unknowns, and balanced evidence for and against every option. Treat abstain or review_required as no recommendation.",
    ],
    parameters: decisionSchema,
    async execute(_id, input, signal) {
      if (!active) throw new Error("Jev is off. /jev on enables it globally for Pi agents");
      const activeSignal = signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
      const key = await readApiKey(join(agentDir, ".env"));
      const result = await evaluate(input, key, activeSignal);
      activeSignal.throwIfAborted();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerCommand("jev", {
    description: "Global Jev bounded-judge configuration: on, off, status",
    getArgumentCompletions: (prefix) => ["on", "off", "status"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!["on", "off", "status"].includes(action)) {
        notify(ctx, "Uso: /jev on | off | status", "error");
        return;
      }
      try {
        if (action !== "status") await writeGlobalConfig(configFile, action === "on");
        await synchronize(ctx, true);
        const config = await readGlobalConfig(configFile);
        const pending = config.enabled !== active;
        notify(ctx, `Jev global: ${config.enabled ? "ligado" : "desligado"}. Neste agente: ${active ? "ligado" : "desligado"}.${pending ? " Aplicação pendente ou impedida; consulte o aviso." : ""}`);
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : "Jev: configuration failed", "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    clearInterval(timer);
    setToolActive(false);
    active = false;
    await synchronize(ctx, true);
    if (!stopped) {
      timer = setInterval(() => { void synchronize(ctx); }, 1000);
      timer.unref();
    }
  });
  pi.on("agent_settled", async (_event, ctx) => { await synchronize(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    clearInterval(timer);
    requests.abort();
    applyMode(ctx, false);
  });
}
