import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { decisionSchema, evaluate, readApiKey } from "./client.ts";
import { readGlobalConfig, writeGlobalConfig } from "./config.ts";

const TOOL = "jev_decide";
const ENTRY = "jev-session-mode-v1";
const savedSchema = Type.Object({
  enabled: Type.Boolean(),
  nativeOff: Type.Boolean(),
  sessionId: Type.String(),
  modelKey: Type.String(),
  previousThinking: StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});
type SavedMode = Static<typeof savedSchema>;
const GUIDANCE = [
  "Jev decision mode is active. Before choosing a nontrivial action or resolving competing hypotheses, call jev_decide with the smallest relevant evidence and concrete alternatives.",
  "Gather missing evidence with existing tools first. Routine acknowledgements and deterministic lookups do not need Jev. After a result changes the evidence, reassess the next decision rather than reusing a stale recommendation.",
  "Only send context authorized for external processing, without secrets or unrelated conversation history. Jev recommendations and confidence are not execution permission or proof. On error, report the unavailable judgment instead of inventing one.",
  "Return concise decisions and observed results, not a transcript of internal reasoning. Jev selects among proposed alternatives; it does not generate code or replace the model's intrinsic capabilities.",
].join("\n");

export default function jevExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const configFile = join(agentDir, "jev.json");
  let mode: SavedMode | undefined;
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
    const active = pi.getActiveTools();
    if (active.includes(TOOL) === enabled) return;
    pi.setActiveTools(enabled ? [...active, TOOL] : active.filter((name) => name !== TOOL));
  }

  function disable(ctx: ExtensionContext, restore: boolean, persist: boolean) {
    const previous = mode;
    mode = undefined;
    setToolActive(false);
    if (!previous) return;
    requests.abort();
    requests = new AbortController();
    if (restore && previous.nativeOff && ctx.model
      && previous.modelKey === `${ctx.model.provider}/${ctx.model.id}`
      && pi.getThinkingLevel() === "off") {
      pi.setThinkingLevel(previous.previousThinking);
    }
    if (persist) pi.appendEntry(ENTRY, { ...previous, enabled: false });
    if (ctx.hasUI) ctx.ui.setStatus("jev", undefined);
  }

  async function enable(ctx: ExtensionContext) {
    if (mode) return;
    if (!ctx.model) throw new Error("Jev: select an execution model first");
    const activationSignal = requests.signal;
    await readApiKey(join(agentDir, ".env"));
    activationSignal.throwIfAborted();
    if (mode || stopped) return;
    const previousThinking = pi.getThinkingLevel();
    const next: SavedMode = {
      enabled: true,
      nativeOff: !ctx.model.reasoning || getSupportedThinkingLevels(ctx.model).includes("off"),
      previousThinking,
      modelKey: `${ctx.model.provider}/${ctx.model.id}`,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    // This entry is only a restoration point. Global jev.json owns activation.
    pi.appendEntry(ENTRY, next);
    if (next.nativeOff) {
      pi.setThinkingLevel("off");
      if (pi.getThinkingLevel() !== "off") {
        pi.setThinkingLevel(previousThinking);
        pi.appendEntry(ENTRY, { ...next, enabled: false });
        throw new Error("Jev: thinking off did not take effect; activation stopped");
      }
    }
    mode = next;
    setToolActive(true);
    if (!next.nativeOff) notify(ctx, "Jev ligado. Este modelo não oferece thinking off; o nível nativo foi preservado.", "warning");
    if (ctx.hasUI) ctx.ui.setStatus("jev", `Jev global · thinking ${pi.getThinkingLevel()}${next.nativeOff ? "" : " · off indisponível"}`);
  }

  function synchronize(ctx: ExtensionContext, boundary = false): Promise<void> {
    if (stopped || (!boundary && !ctx.isIdle())) return Promise.resolve();
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const config = await readGlobalConfig(configFile);
        if (stopped || (!boundary && !ctx.isIdle())) return;
        if (config.enabled) await enable(ctx);
        else disable(ctx, true, true);
        lastError = undefined;
      } catch (error) {
        if (stopped) return;
        disable(ctx, true, true);
        const message = error instanceof Error ? error.message : "Jev: global configuration failed";
        if (message !== lastError) notify(ctx, message, "error");
        lastError = message;
      }
    })().finally(() => { syncing = undefined; });
    return syncing;
  }

  pi.registerTool({
    name: TOOL,
    label: "Jev decision",
    description: "Evaluate a bounded decision through TypeSafe. Returns a recommendation, uncertainty and token usage; executes nothing",
    parameters: decisionSchema,
    async execute(_id, input, signal) {
      if (!mode) throw new Error("Jev is off. /jev on enables it globally for Pi agents");
      const activeSignal = signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
      const key = await readApiKey(join(agentDir, ".env"));
      const result = await evaluate(input, key, activeSignal);
      activeSignal.throwIfAborted();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerCommand("jev", {
    description: "Global Jev configuration for all Pi agents: on, off, status",
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
        await synchronize(ctx);
        const config = await readGlobalConfig(configFile);
        const pending = config.enabled !== Boolean(mode);
        notify(ctx, `Jev global: ${config.enabled ? "ligado" : "desligado"}. Neste agente: ${mode ? "ligado" : "desligado"}. Thinking: ${pi.getThinkingLevel()}.${pending ? " Aplicação pendente ou impedida; consulte o aviso." : ""}`);
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : "Jev: configuration failed", "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    clearInterval(timer);
    setToolActive(false);
    const saved = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ENTRY).at(-1);
    const data = saved?.type === "custom" ? saved.data : undefined;
    if (Check(savedSchema, data) && data.enabled
      && data.sessionId === ctx.sessionManager.getSessionId()
      && ctx.model && data.modelKey === `${ctx.model.provider}/${ctx.model.id}`) {
      mode = data;
      disable(ctx, true, true);
    }
    await synchronize(ctx, true);
    if (!stopped) {
      // A directory watcher can miss replacements. The single bounded poll also
      // observes manual atomic edits, without launching agent turns or network work.
      timer = setInterval(() => { void synchronize(ctx); }, 1000);
      timer.unref();
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await synchronize(ctx, true);
    return mode ? { systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` } : undefined;
  });
  pi.on("agent_settled", async (_event, ctx) => { await synchronize(ctx); });

  pi.on("model_select", async (_event, ctx) => {
    if (mode && ctx.model && mode.modelKey !== `${ctx.model.provider}/${ctx.model.id}`) disable(ctx, false, true);
    await synchronize(ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (!mode || event.level !== pi.getThinkingLevel()
      || event.level === (mode.nativeOff ? "off" : mode.previousThinking)) return;
    mode = { ...mode, nativeOff: false, previousThinking: event.level };
    pi.appendEntry(ENTRY, mode);
    if (ctx.hasUI) ctx.ui.setStatus("jev", `Jev global · thinking ${event.level}`);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    clearInterval(timer);
    requests.abort();
    disable(ctx, true, false);
  });
}
