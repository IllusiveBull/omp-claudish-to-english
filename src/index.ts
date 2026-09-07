/**
 * omp-claudish-to-english — plain-language assistant-message rewriter for OMP.
 *
 * Inherits model auth from the OMP session: completions go through the host's
 * own pipeline (`completeSimple` + ModelRegistry API-key resolver), so every
 * provider OMP supports — including OAuth, token-exchange, and subscription
 * providers — works without extension-side HTTP code.
 *
 * Display-only: the rewrite is appended to the transcript as a custom
 * message once the session is idle; a context filter strips it from LLM
 * context, so it never affects the agent's reasoning.
 */

import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ── Minimal structural types for OMP runtime objects ─────────────────────
// Everything from the runtime context is mirrored here just enough for type
// safety; the Model object itself is opaque and passed straight through.

interface ContentBlock {
  type: string;
  text?: string;
}

/** Opaque OMP Model object; only `id` is inspected. */
interface ModelRef {
  id?: string;
  [key: string]: unknown;
}

interface ModelsApi {
  resolve?(spec: string): ModelRef | undefined;
  current?(): ModelRef | undefined;
  list?(): ModelRef[];
}

/** Subset of OMP ModelRegistry: session-aware API-key resolver factory. */
interface RegistryLike {
  resolver?(model: ModelRef, sessionId?: string): unknown;
}

interface ExtCtx {
  models?: ModelsApi;
  modelRegistry?: RegistryLike;
  sessionManager?: SessionManagerLike;
  ui: { notify(msg: string, level: string): void };
}

/** Subset of a session-transcript entry: enough to spot turn boundaries. */
interface EntryLike {
  type?: string;
  customType?: string;
  attribution?: string;
  message?: { role?: string; stopReason?: string };
}

/** Subset of OMP SessionManager: read-only current-branch access. */
interface SessionManagerLike {
  getBranch?(): EntryLike[];
}

// ── Domain types ─────────────────────────────────────────────────────────

type Mode = "append" | "off";
type Style = "default" | "tldr" | "5y" | "caveman";

interface State {
  mode: Mode;
  style: Style;
  language: string;
  modelSpec: string;
}


// ── Constants ────────────────────────────────────────────────────────────

const CUSTOM_TYPE = "claudish-rewrite";
const MIN_CHARS = 200;
const TIMEOUT_MS = 45_000;


// ── Prompts ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<Style, string> = {
  default:
    "You rewrite the assistant's message into much simpler, plain language. " +
    "Write the rewrite in the same language as the message you are rewriting. " +
    "Keep every fact, name, number, and file path. Use short sentences and everyday words. " +
    "Leave fenced code blocks unchanged. " +
    "Output ONLY the rewritten message with no preamble, labels, or commentary.",
  tldr:
    "You rewrite the assistant's message as a SHORT summary in simple, plain language. " +
    "This is a simplification, NOT a translation: it must be clearly shorter than the original — " +
    "aim for half its length or less. Keep the key facts, decisions, numbers, and file paths; " +
    "drop repetitions, hedges, and secondary detail. Keep technical terms, commands, and " +
    "identifiers in their original form. Omit fenced code blocks (the original text is always " +
    "in the transcript). Write the rewrite in the same language as the message you are rewriting. " +
    "Output ONLY the rewritten message with no preamble, labels, or commentary.",
  "5y":
    "You rewrite the assistant's message as if explaining it to a five-year-old: very simple " +
    "words, short sentences, a friendly tone, and simple comparisons for hard ideas. Keep every " +
    "important fact, name, number, and file path accurate. Keep technical terms, commands, and " +
    "identifiers in their original form. Leave fenced code blocks unchanged. Write the rewrite " +
    "in the same language as the message you are rewriting. " +
    "Output ONLY the rewritten message with no preamble, labels, or commentary.",
  caveman:
    "You rewrite the assistant's message as blunt caveman speak: very short sentences, simple " +
    "forceful words, no articles, present tense. Grunt where a sentence would only hedge. Keep " +
    "every important fact, name, number, and file path accurate — caveman is dumb about grammar, " +
    "never about facts. Keep technical terms, commands, identifiers, and file paths exactly as " +
    "written; do not cave-speak them. Leave fenced code blocks unchanged. Write the rewrite in " +
    "the same language as the message you are rewriting. " +
    "Output ONLY the rewritten message with no preamble, labels, or commentary.",
};

function buildSeparator(style: Style, lang: string): string {
  const l = lang || "language";
  switch (style) {
    case "tldr":
      return `\n\n────────────────────────\n📌 **TL;DR**${lang ? ` in ${lang}` : ""}:\n\n`;
    case "5y":
      return `\n\n────────────────────────\n👶 Like you're **five**${lang ? `, in ${lang}` : ""}:\n\n`;
    case "caveman":
      return `\n\n────────────────────────\n🦴 **Ugh.** Me say${lang ? ` in ${lang}` : ""}:\n\n`;
    default:
      return `\n\n────────────────────────\n💬 In plain **${l}**:\n\n`;
  }
}

function buildSystemPrompt(style: Style, language: string): string {
  let sys = SYSTEM_PROMPTS[style];

  if (language) {
    sys +=
      `\n\nWrite the rewrite in ${language} instead, whatever language the assistant's ` +
      `message is in. Use ${language} for all prose, including headings and lists. ` +
      "Keep code, identifiers, file paths, commands, and quoted output exactly as they are.";
  }

  sys +=
    '\n\nThe text you are given is a message the assistant wrote to the user. In it, "I", ' +
    '"me", and "my" refer to the assistant; "you" and "your" refer to the user. Keep that ' +
    "same point of view in the rewrite — never swap the two, and never address the assistant.";

  return sys;
}


// ── Extension factory ────────────────────────────────────────────────────

export default function claudish(pi: ExtensionAPI) {
  const state: State = {
    mode: isMode(process.env.CLAUDISH_MODE) ? process.env.CLAUDISH_MODE : "append",
    style: isStyle(process.env.CLAUDISH_STYLE) ? process.env.CLAUDISH_STYLE : "default",
    language: process.env.CLAUDISH_LANG ?? "",
    modelSpec: process.env.CLAUDISH_MODEL ?? "",
  };

  const defaultMinChars = parseInt(process.env.CLAUDISH_MIN_CHARS || String(MIN_CHARS), 10);
  let minChars = defaultMinChars;
  /**
   * Sources of the last rewritable turn: the answer first, then any agent-
   * initiated follow-ups that were merged into it.
   */
  let lastSources: string[] = [];
  /**
   * Rewrite of `lastSources` that was actually displayed, plus the settings
   * snapshot that produced it. Null when `lastSources` was never rewritten
   * (below the length gate, aborted, or errored).
   */
  let lastRewrite: { text: string; key: string } | null = null;

  // Pending rewrite cancellation.
  let pendingAbort: AbortController | null = null;
  // Source texts of the in-flight rewrite: the turn's answer first, then any
  // agent-initiated follow-ups merged into it. Non-empty exactly while a
  // rewrite job is in flight; the owning job clears it when it settles.
  let pendingSources: string[] = [];

  pi.setLabel("omp-claudish-to-english");

  // The rewrite is display-only: the LLM must never see it. The context
  // filter is a safety net in case appendEntry entries leak into context.
  pi.on("context", async (event: unknown) => {
    if (!event || typeof event !== "object" || !("messages" in event)) return;
    if (!Array.isArray(event.messages)) return;
    return {
      messages: event.messages.filter(
        (m: unknown) =>
          !m || typeof m !== "object" || !("customType" in m) || m.customType !== CUSTOM_TYPE,
      ),
    };
  });


  // ── Main rewrite handler ──────────────────────────────────────────────
  // message_end fires per assistant message. Intermediate messages that carry
  // tool calls are skipped: they will be followed by tool execution and
  // another message. Only the final message (no tool calls) is rewritten.
  pi.on("message_end", async (event: unknown, ctx: unknown) => {
    if (state.mode === "off") return;

    // Narrow event → message → content.
    if (!event || typeof event !== "object" || !("message" in event)) return;
    const msg = event.message;
    if (!msg || typeof msg !== "object" || !("content" in msg)) return;
    // Only rewrite assistant messages.
    if (!("role" in msg) || msg.role !== "assistant") return;
    // Skip our own rewrite messages to prevent recursion.
    if ("customType" in msg && msg.customType === CUSTOM_TYPE) return;
    // Skip intermediate messages — a tool execution follows, then another
    // assistant message. OMP marks these with stopReason "toolUse" and
    // content blocks of type "toolCall" (pi-ai ToolCall).
    if ("stopReason" in msg && msg.stopReason !== "stop") return;
    const rawContent = msg.content;
    if (!rawContent) return;

    if (Array.isArray(rawContent)) {
      const hasToolUse = rawContent.some((b: unknown) =>
        !!b && typeof b === "object" && "type" in b && b.type === "toolCall");
      if (hasToolUse) return;
    }

    let fullText: string;
    if (Array.isArray(rawContent)) {
      fullText = rawContent
        .filter((b: unknown): b is ContentBlock =>
          !!b && typeof b === "object" && "type" in b && b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    } else if (typeof rawContent === "string") {
      fullText = rawContent;
    } else {
      return;
    }

    // Classify the turn. A user-initiated turn replaces the pending rewrite
    // outright. An agent-initiated follow-up — an advisor note, a stop-hook
    // continuation, any agent-injected steer that lands on an already-finished
    // answer and spawns a bonus turn — can confirm or reverse that answer, so
    // it is folded into the answer's rewrite while that rewrite is still in
    // flight: the single box then reflects the final position. Once the
    // previous rewrite has already appended, a follow-up is rewritten on its
    // own — the length gate filters short acknowledgements, and a substantial
    // follow-up (a reversal, new work after a blocker) earns its own box.
    const smRaw = ctx && typeof ctx === "object" && "sessionManager" in ctx
      ? ctx.sessionManager
      : undefined;
    // Structural mirror of the opaque host SessionManager; only getBranch is
    // touched, and its result is re-checked with Array.isArray below.
    const sm = smRaw as SessionManagerLike | undefined;
    const branch = sm?.getBranch?.();
    const followUp = Array.isArray(branch) && isAgentFollowUpTurn(branch);
    const merging = followUp && pendingSources.length > 0;
    const sources = merging ? [...pendingSources, fullText] : [fullText];

    lastSources = sources;
    lastRewrite = null;

    // Prose-length gate: strip fenced code blocks, then count non-whitespace.
    const proseLen = sources.join("\n\n")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\s/g, "").length;
    if (proseLen < minChars) return;

    const host = narrowHost(ctx);
    if (!host) return;

    // A merging follow-up re-issues the pending rewrite with itself folded in.
    startRewrite(sources, host);
  });

  // ── /claudish command ─────────────────────────────────────────────────
  pi.registerCommand("claudish", {
    description:
      "Control claudish rewrite: on|off|style <tldr|5y|caveman|default>|language <name>|model <spec>|min <chars>|last|reset",
    handler: async (args: string, ctx: unknown) => {
      const ui = ctx && typeof ctx === "object" && "ui" in ctx
        ? ctx.ui as ExtCtx["ui"]
        : { notify() {} };
      const parts = args.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase() ?? "";
      const rest = parts.slice(1).join(" ").trim();

      switch (cmd) {
        case "on":
          state.mode = "append";
          break;
        case "off":
          state.mode = "off";
          break;
        case "min": {
          const n = parseInt(rest, 10);
          if (Number.isFinite(n) && n >= 0) {
            minChars = n;
          } else {
            ui.notify(`Invalid min length: ${rest || "(empty)"}. Use a non-negative number.`, "warn");
            return;
          }
          break;
        }
        case "style":
          if (isStyle(rest)) {
            state.style = rest;
          } else if (!rest) {
            state.style = "default";
          } else {
            ui.notify(`Unknown style: ${rest}. Use tldr, 5y, caveman, or default.`, "warn");
            return;
          }
          break;
        case "language":
          state.language = rest;
          break;
        case "model":
          state.modelSpec = rest;
          break;
        case "last": {
          if (lastSources.length === 0) {
            ui.notify("No previous message recorded.", "warn");
            return;
          }
          // Settings unchanged since the displayed rewrite → replay it. Any
          // change (style, language, model) or a message that never got a
          // rewrite (length gate, abort, error) → rewrite now with the current
          // settings. The explicit request bypasses the length gate.
          if (lastRewrite && lastRewrite.key === settingsKey()) {
            showRewrite(lastRewrite.text, state.style, state.language);
            return;
          }
          const host = narrowHost(ctx);
          if (!host) {
            ui.notify("claudish: no model available for rewriting.", "warn");
            return;
          }
          startRewrite(lastSources, host);
          ui.notify(
            `claudish: rewriting last message · style: ${state.style} · lang: ${state.language || "auto"}`,
            "info",
          );
          return;
        }
        case "reset":
          state.mode = "append";
          state.style = "default";
          state.language = "";
          state.modelSpec = "";
          minChars = defaultMinChars;
          break;
        default: {
          const models = ctx && typeof ctx === "object" && "models" in ctx
            ? ctx.models as ModelsApi | undefined
            : undefined;
          const resolved = models ? resolveModel(models, state) : undefined;
          const lines = [
            "claudish · plain-language rewrite",
            "",
            `  status    ${state.mode}`,
            `  style     ${state.style}`,
            `  language  ${state.language || "(auto)"}`,
            `  min       ${minChars} chars`,
            `  model     ${state.modelSpec || "(auto)"}${resolved ? ` → ${modelLabel(resolved)}` : ""}`,
          ];
          ui.notify(lines.join("\n"), "info");
          return;
        }
      }

      ui.notify(
        `claudish: ${state.mode} · style: ${state.style} · lang: ${state.language || "auto"} · model: ${state.modelSpec || "auto"} · min: ${minChars}`,
        "info",
      );
    },
  });

  // ── Internal helpers ──────────────────────────────────────────────────

  /** Host surfaces a rewrite needs, narrowed from an opaque hook/command ctx. */
  interface RewriteHost {
    models: ModelsApi;
    resolver: (model: ModelRef, sessionId?: string) => unknown;
    isIdle: () => boolean;
    hasPending: () => boolean;
  }

  function narrowHost(ctx: unknown): RewriteHost | undefined {
    if (!ctx || typeof ctx !== "object") return undefined;
    const models = "models" in ctx ? ctx.models as ModelsApi | undefined : undefined;
    const registry = "modelRegistry" in ctx ? ctx.modelRegistry as RegistryLike | undefined : undefined;
    if (!models || !registry?.resolver) return undefined;
    return {
      models,
      resolver: registry.resolver.bind(registry),
      isIdle: boolMethod(ctx, "isIdle") ?? (() => true),
      hasPending: boolMethod(ctx, "hasPendingMessages") ?? (() => false),
    };
  }

  /** Bound zero-arg method of `obj` coerced to boolean, if present. */
  function boolMethod(obj: object, name: string): (() => boolean) | undefined {
    if (!(name in obj)) return undefined;
    const fn: unknown = obj[name as keyof typeof obj];
    if (typeof fn !== "function") return undefined;
    return () => Boolean(fn.call(obj));
  }

  /** Identity of the settings that shape a rewrite's output. */
  function settingsKey(): string {
    return `${state.style}\u0000${state.language}\u0000${state.modelSpec}`;
  }

  function showRewrite(text: string, style: Style, language: string): void {
    pi.sendMessage(
      { customType: CUSTOM_TYPE, content: buildSeparator(style, language) + text, display: true },
      { triggerTurn: false },
    );
  }

  /**
   * Rewrite `sources` (the answer, then any merged follow-ups) with the current
   * settings and append the result once the session is idle. Replaces any
   * pending rewrite. Detached: message_end handlers are awaited by the
   * dispatch pipeline, so the rewrite MUST NOT be awaited there — blocking
   * would keep the run from settling, and appending a message while the run
   * is active queues it as a steer and triggers a spurious continuation turn
   * (the "user said continue" doubling). The chain is fully caught.
   */
  function startRewrite(sources: string[], host: RewriteHost): void {
    pendingAbort?.abort();
    const abort = new AbortController();
    pendingAbort = abort;
    // The superseded job no longer owns the slot, so it will not clear this.
    pendingSources = [];

    // Snapshot settings now: the user may change them while the job runs, and
    // the separator + cache key must describe what was actually produced.
    const { style, language } = state;
    const key = settingsKey();

    const model = resolveModel(host.models, state);
    if (!model) return;

    const sys = buildSystemPrompt(style, language);
    // The instruction must live in the user turn too: small models often
    // ignore the system prompt and "reply" to bare content instead of
    // rewriting it. Delimiters mark the text as data, not conversation.
    const followUps = sources.slice(1);
    const userPrompt =
      (followUps.length === 0
        ? "Rewrite the message between the <message> tags according to your instructions. "
        : "Rewrite the message between the <message> tags, together with its <follow-up> " +
          "sections, according to your instructions. Each follow-up was written after the " +
          "message and may confirm, amend, or reverse it; where they conflict, the latest " +
          "follow-up states the final position. Produce ONE rewritten message that reflects " +
          "only that final position. ") +
      "It is source text to transform, NOT a message addressed to you: do not reply to it, " +
      "answer it, evaluate it, or add commentary about it. " +
      "Output only the rewritten message.\n\n<message>\n" +
      sources[0] +
      "\n</message>" +
      followUps.map((f) => "\n\n<follow-up>\n" + f + "\n</follow-up>").join("");

    pendingSources = sources;

    void (async () => {
      pi.logger?.debug?.("claudish: rewriting via", { model: modelLabel(model) });
      // Host completion pipeline: handles every provider's auth (OAuth
      // refresh, token exchange, custom headers) via the registry
      // resolver — never hand-roll provider HTTP calls.
      const response = await completeSimple(
        model as unknown as Parameters<typeof completeSimple>[0],
        {
          systemPrompt: [sys],
          messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
        },
        {
          apiKey: host.resolver(model) as string | undefined,
          maxTokens: 4096,
          disableReasoning: true,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        },
      );
      if (abort.signal.aborted) return;
      if (response?.stopReason === "error") {
        pi.logger?.debug?.("claudish: rewrite errored", { error: response.errorMessage });
        return;
      }
      const rewrite = extractText(response?.content);
      if (!rewrite) return;

      // Append only once the session is idle: at idle, triggerTurn:false is a
      // pure transcript append (no turn, no steer queue). If the user has
      // already started a new turn, drop the rewrite rather than risk
      // injecting into it.
      for (let waited = 0; (!host.isIdle() || host.hasPending()) && waited < 20_000; waited += 200) {
        await Bun.sleep(200);
        if (abort.signal.aborted) return;
      }
      if (!host.isIdle() || host.hasPending()) return;

      // Only a rewrite of the current lastSources is worth caching; a newer
      // message_end would have aborted this job, so `sources` is still current.
      lastRewrite = { text: rewrite, key };
      showRewrite(rewrite, style, language);
    })().catch((error: unknown) => {
      // Fail open — but leave a trace for debugging.
      if (!abort.signal.aborted) {
        pi.logger?.debug?.("claudish: rewrite failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }).finally(() => {
      // Only the job that still owns the slot releases the sources; a
      // superseding job has already replaced both fields.
      if (pendingAbort === abort) pendingSources = [];
    });
  }

  function resolveModel(models: ModelsApi, st: State): ModelRef | undefined {
    // 1. Explicit spec (supports @role aliases: /claudish model @slow).
    if (st.modelSpec) {
      const m = models.resolve?.(st.modelSpec);
      if (m) return m;
    }

    // 2. OMP role aliases — tiny first: it is OMP's semantic role for small
    //    utility tasks (titles, classifiers, rewrites) and, when unset, falls
    //    through to the smol priority chain anyway (ROLE_PRIORITY_ALIAS).
    const currentId = models.current?.()?.id ?? "";
    for (const role of ["@tiny", "@smol"]) {
      const m = models.resolve?.(role);
      if (m && m.id !== currentId) return m;
    }

    // 3. Last resort: the session's own model (guaranteed authed), then any.
    return models.current?.() ?? models.list?.()?.[0];
  }
}

// ── Type guards ──────────────────────────────────────────────────────────

function isMode(v: unknown): v is Mode {
  return v === "append" || v === "off";
}

function modelLabel(m: ModelRef): string {
  const provider = typeof m.provider === "string" ? m.provider : "";
  return provider ? `${provider}/${m.id ?? "?"}` : String(m.id ?? "?");
}

function isStyle(v: unknown): v is Style {
  return v === "default" || v === "tldr" || v === "5y" || v === "caveman";
}

/**
 * True when the latest turn was initiated by the agent/host rather than the
 * user, as a bonus turn spawned on top of an already-complete answer — an
 * advisor note the agent acknowledges, a stop-hook continuation, or any other
 * agent-injected steer that lands after a finished answer.
 *
 * Detection walks the current branch back from the leaf, decoupled from any one
 * subsystem: it skips the turn's own assistant/tool/state entries and the
 * display-only rewrites we appended, then classifies what triggered the turn.
 * A user `message` or a user-attributed injection means a genuine user turn. An
 * agent-attributed injected message is a follow-up only when (2) the entry it
 * landed on is itself a completed assistant answer (`stopReason` "stop"). That
 * second condition separates an after-the-fact follow-up from an agent steer
 * (e.g. an advisor `concern`/`blocker`) that reshaped an in-flight user turn —
 * the latter still yields a real answer worth rewriting.
 */
function isAgentFollowUpTurn(branch: EntryLike[]): boolean {
  let i = branch.length - 1;
  for (; i >= 0; i--) {
    const e = branch[i];
    if (!e || typeof e !== "object") continue;
    if (e.type === "message") {
      if (e.message?.role === "user") return false; // genuine user turn
      continue; // assistant / toolResult: part of the current turn
    }
    if (e.type === "custom_message") {
      if (e.customType === CUSTOM_TYPE) continue; // our own display rewrite
      if (e.attribution === "user") return false; // user-injected prompt
      break; // agent-injected message (advisor note, etc.) triggered this turn
    }
    // custom markers and *_change entries: turn scaffolding, keep walking.
  }
  if (i < 0) return false;

  for (let j = i - 1; j >= 0; j--) {
    const e = branch[j];
    if (!e || typeof e !== "object") continue;
    if (e.type === "custom_message") {
      if (e.attribution !== "user") continue; // stacked agent injections / rewrites
      return false; // a user injection is the real trigger
    }
    if (e.type === "message") {
      if (e.message?.role === "assistant") return e.message?.stopReason === "stop";
      return false; // toolResult / user before an assistant: mid-turn steer
    }
  }
  return false;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: unknown): b is ContentBlock =>
      !!b && typeof b === "object" && "type" in b && (b as ContentBlock).type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}
