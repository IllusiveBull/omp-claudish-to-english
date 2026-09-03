import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import claudish, {
  buildSeparator,
  buildSystemPrompt,
  extractText,
  getLastUserPrompt,
  MAX_USER_PROMPT_CHARS,
  SYSTEM_PROMPTS,
  truncateCodepoints,
} from "../src/index.js";

describe("buildSystemPrompt", () => {
  it("generates base system prompt for default style", () => {
    const prompt = buildSystemPrompt("default", "");
    expect(prompt).toContain(SYSTEM_PROMPTS.default);
    expect(prompt).toContain('In it, "I", "me", and "my" refer to the assistant');
    expect(prompt).not.toContain("For context, the user asked the assistant");
  });

  it("appends language instruction when language is specified", () => {
    const prompt = buildSystemPrompt("default", "Chinese");
    expect(prompt).toContain("Write the rewrite in Chinese instead");
    expect(prompt).toContain("Use Chinese for all prose");
  });

  it("injects user question context when provided", () => {
    const userQ = "Why is the database timing out after 45 seconds?";
    const prompt = buildSystemPrompt("default", "", userQ);
    expect(prompt).toContain(
      'For context, the user asked the assistant: "Why is the database timing out after 45 seconds?".',
    );
    expect(prompt).toContain(
      "Do NOT rewrite, answer, or repeat the user's question — rewrite only the assistant's message that follows.",
    );
  });

  it("handles both language and user question together", () => {
    const prompt = buildSystemPrompt("tldr", "Japanese", "How do I fix bug #42?");
    expect(prompt).toContain(SYSTEM_PROMPTS.tldr);
    expect(prompt).toContain("Write the rewrite in Japanese instead");
    expect(prompt).toContain('For context, the user asked the assistant: "How do I fix bug #42?".');
  });

  it("supports all styles", () => {
    for (const style of ["default", "tldr", "5y", "caveman"] as const) {
      const prompt = buildSystemPrompt(style, "", "Hello");
      expect(prompt).toContain(SYSTEM_PROMPTS[style]);
      expect(prompt).toContain('For context, the user asked the assistant: "Hello".');
    }
  });
});

describe("extractText", () => {
  it("extracts plain string", () => {
    expect(extractText("  hello world  ")).toBe("hello world");
    expect(extractText("")).toBe("");
  });

  it("extracts and concatenates text blocks from array", () => {
    const blocks = [
      { type: "text", text: "Part 1. " },
      { type: "toolCall", id: "123" },
      { type: "text", text: "Part 2." },
    ];
    expect(extractText(blocks)).toBe("Part 1. Part 2.");
  });

  it("returns empty string for invalid inputs", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
    expect(extractText(12345)).toBe("");
    expect(extractText({})).toBe("");
  });
});

describe("truncateCodepoints", () => {
  it("preserves strings shorter than limit", () => {
    expect(truncateCodepoints("hello", 10)).toBe("hello");
  });

  it("truncates multi-byte unicode / emoji safely by codepoints", () => {
    const emojiStr = "👨‍👩‍👧‍👦".repeat(10);
    const truncated = truncateCodepoints(emojiStr, 5);
    expect(Array.from(truncated).length).toBe(5);
  });
});

describe("getLastUserPrompt", () => {
  it("extracts the latest user message from session entries", () => {
    const sessionManager = {
      getEntries() {
        return [
          { type: "message", message: { role: "user", content: "First question" } },
          { type: "message", message: { role: "assistant", content: "First answer" } },
          { type: "message", message: { role: "user", content: "Second question" } },
          { type: "message", message: { role: "assistant", content: "Second answer" } },
        ];
      },
    };

    const prompt = getLastUserPrompt(sessionManager);
    expect(prompt).toBe("Second question");
  });

  it("prefers getBranch() when available", () => {
    const sessionManager = {
      getBranch() {
        return [
          { type: "message", message: { role: "user", content: "Branch question" } },
          { type: "message", message: { role: "assistant", content: "Branch answer" } },
        ];
      },
      getEntries() {
        return [
          { type: "message", message: { role: "user", content: "Root question" } },
        ];
      },
    };

    const prompt = getLastUserPrompt(sessionManager);
    expect(prompt).toBe("Branch question");
  });

  it("truncates user message longer than MAX_USER_PROMPT_CHARS", () => {
    const longQuestion = "a".repeat(1000);
    const sessionManager = {
      getEntries() {
        return [
          { type: "message", message: { role: "user", content: longQuestion } },
        ];
      },
    };

    const prompt = getLastUserPrompt(sessionManager);
    expect(prompt.length).toBe(MAX_USER_PROMPT_CHARS);
    expect(prompt).toBe("a".repeat(MAX_USER_PROMPT_CHARS));
  });

  it("falls back to memory fallback when sessionManager is absent or empty", () => {
    expect(getLastUserPrompt(undefined, "fallback prompt")).toBe("fallback prompt");
    expect(getLastUserPrompt({ getEntries: () => [] }, "fallback prompt")).toBe("fallback prompt");
  });

  it("returns empty string when no user message exists", () => {
    const sessionManager = {
      getEntries() {
        return [
          { type: "message", message: { role: "assistant", content: "Hi" } },
        ];
      },
    };
    expect(getLastUserPrompt(sessionManager, "")).toBe("");
  });
});

describe("buildSeparator", () => {
  it("formats default separator with language", () => {
    expect(buildSeparator("default", "English")).toContain("💬 In plain **English**:");
    expect(buildSeparator("default", "")).toContain("💬 In plain **language**:");
  });

  it("formats tldr separator", () => {
    expect(buildSeparator("tldr", "")).toContain("📌 **TL;DR**:");
    expect(buildSeparator("tldr", "French")).toContain("📌 **TL;DR** in French:");
  });

  it("formats 5y separator", () => {
    expect(buildSeparator("5y", "")).toContain("👶 Like you're **five**:");
  });

  it("formats caveman separator", () => {
    expect(buildSeparator("caveman", "")).toContain("🦴 **Ugh.** Me say:");
  });
});

describe("claudish extension factory", () => {
  it("registers event handlers and command", () => {
    const registeredEvents: Record<string, unknown> = {};
    let registeredCommandName = "";
    let registeredCommandDef: unknown = null;
    let label = "";

    const fakePi: Partial<ExtensionAPI> = {
      setLabel(l: string) {
        label = l;
      },
      on(event: string, handler: unknown) {
        registeredEvents[event] = handler;
      },
      registerCommand(name: string, def: unknown) {
        registeredCommandName = name;
        registeredCommandDef = def;
      },
    };

    // Mocking the extension runtime boundary for tests.
    claudish(fakePi as unknown as ExtensionAPI);
    expect(label).toBe("omp-claudish-to-english");
    expect(registeredEvents.context).toBeFunction();
    expect(registeredEvents.message_end).toBeFunction();
    expect(registeredCommandName).toBe("claudish");
    expect(registeredCommandDef).toBeObject();
  });

  it("filters claudish-rewrite from context", async () => {
    const registeredEvents: Record<string, unknown> = {};
    const fakePi: Partial<ExtensionAPI> = {
      setLabel() {},
      on(event: string, handler: unknown) {
        registeredEvents[event] = handler;
      },
      registerCommand() {},
    };
    // Mocking the extension runtime boundary for tests.
    claudish(fakePi as unknown as ExtensionAPI);

    const contextHandler = registeredEvents.context as (event: {
      messages: Array<Record<string, unknown>>;
    }) => Promise<{ messages: Array<Record<string, unknown>> }>;
    const filtered = await contextHandler({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "World", customType: "claudish-rewrite" },
        { role: "assistant", content: "Real message" },
      ],
    });

    expect(filtered.messages).toHaveLength(2);
    expect(filtered.messages[0].content).toBe("Hello");
    expect(filtered.messages[1].content).toBe("Real message");
  });
});
