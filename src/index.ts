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
  ui: { notify(msg: string, level: string): void };
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
  let lastOriginal = "";

  // Pending rewrite cancellation.
  let pendingAbort: AbortController | null = null;

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

    lastOriginal = fullText;

    // Prose-length gate: strip fenced code blocks, then count non-whitespace.
    const proseLen = fullText
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\s/g, "").length;
    if (proseLen < minChars) return;

    // Cancel a prior pending rewrite.
    pendingAbort?.abort();
    const abort = new AbortController();
    pendingAbort = abort;

    // Narrow ctx for models + registry access.
    const models = ctx && typeof ctx === "object" && "models" in ctx
      ? ctx.models as ModelsApi | undefined
      : undefined;
    const registry = ctx && typeof ctx === "object" && "modelRegistry" in ctx
      ? ctx.modelRegistry as RegistryLike | undefined
      : undefined;
    const isIdle = ctx && typeof ctx === "object" && "isIdle" in ctx &&
      typeof (ctx as { isIdle: unknown }).isIdle === "function"
      ? () => Boolean((ctx as { isIdle(): boolean }).isIdle())
      : () => true;
    const hasPending = ctx && typeof ctx === "object" && "hasPendingMessages" in ctx &&
      typeof (ctx as { hasPendingMessages: unknown }).hasPendingMessages === "function"
      ? () => Boolean((ctx as { hasPendingMessages(): boolean }).hasPendingMessages())
      : () => false;
    if (!models || !registry?.resolver) return;
    const resolver = registry.resolver.bind(registry);

    const model = resolveModel(models, state);
    if (!model || abort.signal.aborted) return;

    const sys = buildSystemPrompt(state.style, state.language);
    // The instruction must live in the user turn too: small models often
    // ignore the system prompt and "reply" to bare content instead of
    // rewriting it. Delimiters mark the text as data, not conversation.
    const userPrompt =
      "Rewrite the message between the <message> tags according to your instructions. " +
      "It is source text to transform, NOT a message addressed to you: do not reply to it, " +
      "answer it, evaluate it, or add commentary about it. " +
      "Output only the rewritten message.\n\n<message>\n" +
      fullText +
      "\n</message>";

    // Detached job: the message_end handler is awaited by the dispatch
    // pipeline, so the rewrite MUST NOT be awaited here — blocking would keep
    // the run from settling, and appending a message while the run is active
    // queues it as a steer and triggers a spurious continuation turn (the
    // "user said continue" doubling). The chain is fully caught.
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
          apiKey: resolver(model) as string | undefined,
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
      for (let waited = 0; (!isIdle() || hasPending()) && waited < 20_000; waited += 200) {
        await new Promise((r) => setTimeout(r, 200));
        if (abort.signal.aborted) return;
      }
      if (!isIdle() || hasPending()) return;

      const sep = buildSeparator(state.style, state.language);
      pi.sendMessage(
        { customType: CUSTOM_TYPE, content: sep + rewrite, display: true },
        { triggerTurn: false },
      );
    })().catch((error: unknown) => {
      // Fail open — but leave a trace for debugging.
      if (!abort.signal.aborted) {
        pi.logger?.debug?.("claudish: rewrite failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
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
        case "last":
          if (lastOriginal) {
            pi.sendMessage(
              {
                customType: CUSTOM_TYPE,
                content:
                  "\n\n────────────────────────\n📄 **Original message**:\n\n" + lastOriginal,
                display: true,
              },
              { triggerTurn: false },
            );
          } else {
            ui.notify("No previous message recorded.", "warn");
          }
          return;
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

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: unknown): b is ContentBlock =>
      !!b && typeof b === "object" && "type" in b && (b as ContentBlock).type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}
