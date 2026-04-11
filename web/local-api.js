/**
 * Memoir — Local API shim + multi-provider AI
 * ─────────────────────────────────────────────────────────────────────
 *
 * Runs 100% client-side. Intercepts all fetch("/api/*") calls the app makes
 * and handles them locally. Data lives either in:
 *   • A JSON file on disk via Tauri commands (desktop app), OR
 *   • localStorage (browser-only version on GitHub Pages)
 *
 * AI calls go directly from the client to the user's chosen provider:
 *   • Google Gemini (default — free tier is most generous)
 *   • OpenAI
 *   • Anthropic (Claude)
 *   • Ollama (local model server — no API key needed)
 *
 * The user's API key is stored locally and only ever sent to the provider
 * they selected. Nothing goes through any Memoir server (there is none).
 */
(function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────────────
  // Environment detection
  // ─────────────────────────────────────────────────────────────────────

  // Tauri v2 exposes invoke via __TAURI_INTERNALS__; __TAURI__ is available
  // only when `withGlobalTauri: true` is set in tauri.conf.json. Detect both.
  const IS_TAURI =
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  const tauriInvoke = !IS_TAURI
    ? null
    : window.__TAURI_INTERNALS__
    ? window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__)
    : window.__TAURI__.core.invoke.bind(window.__TAURI__.core);

  // Desktop-only: pipe JS errors + console output to a Rust log file so we
  // can debug from outside the sandboxed webview.
  function debugLog(msg) {
    if (!tauriInvoke) return;
    try {
      tauriInvoke("log_debug", { message: String(msg) }).catch(() => {});
    } catch {}
  }
  if (IS_TAURI) {
    debugLog("js: local-api.js top-level reached");
    window.addEventListener("error", (e) => {
      debugLog(`js ERROR: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason;
      debugLog("js UNHANDLED_REJECTION: " + (r && (r.stack || r.message) || r));
    });
    const origError = console.error.bind(console);
    console.error = function () {
      debugLog("console.error: " + Array.from(arguments).map(String).join(" "));
      origError.apply(console, arguments);
    };
    const origWarn = console.warn.bind(console);
    console.warn = function () {
      debugLog("console.warn: " + Array.from(arguments).map(String).join(" "));
      origWarn.apply(console, arguments);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => debugLog("js: DOMContentLoaded"));
    } else {
      debugLog("js: script loaded after DOMContentLoaded");
    }
    window.addEventListener("load", () => debugLog("js: window load"));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Provider registry
  //
  // Each provider has a list of models, a default model, a hint about where
  // to get a key, and a flag for whether a key is needed (Ollama doesn't).
  // `hint` uses simple object format that we'll render as DOM nodes — no
  // raw HTML strings, no innerHTML, no XSS surface.
  // ─────────────────────────────────────────────────────────────────────

  const PROVIDERS = {
    gemini: {
      label: "Google Gemini",
      models: [
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (recommended — fast, free tier)" },
        { id: "gemini-flash-latest", label: "Gemini Flash (latest stable alias)" },
        { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (fastest)" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (most capable)" },
        { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      ],
      defaultModel: "gemini-2.5-flash",
      hintParts: [
        { text: "Free tier: 1,500 requests/day. Get a key at " },
        { link: "https://aistudio.google.com/apikey", text: "aistudio.google.com/apikey" },
      ],
      needsKey: true,
    },
    openai: {
      label: "OpenAI",
      models: [
        { id: "gpt-4o-mini", label: "GPT-4o Mini (cheap, fast)" },
        { id: "gpt-4o", label: "GPT-4o (most capable)" },
        { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
      ],
      defaultModel: "gpt-4o-mini",
      hintParts: [
        { text: "Get a key at " },
        { link: "https://platform.openai.com/api-keys", text: "platform.openai.com/api-keys" },
      ],
      needsKey: true,
    },
    anthropic: {
      label: "Anthropic",
      models: [
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fast)" },
        { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5 (balanced)" },
        { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5 (most capable)" },
      ],
      defaultModel: "claude-haiku-4-5-20251001",
      hintParts: [
        { text: "Get a key at " },
        { link: "https://console.anthropic.com/settings/keys", text: "console.anthropic.com" },
      ],
      needsKey: true,
    },
    ollama: {
      label: "Ollama (local)",
      models: [
        { id: "llama3.2", label: "Llama 3.2" },
        { id: "llama3.1", label: "Llama 3.1" },
        { id: "qwen2.5", label: "Qwen 2.5" },
        { id: "mistral", label: "Mistral" },
      ],
      defaultModel: "llama3.2",
      hintParts: [
        { text: "Runs a local model — 100% offline. Install from " },
        { link: "https://ollama.com", text: "ollama.com" },
        { text: ", then run " },
        { code: "ollama pull llama3.2" },
      ],
      needsKey: false,
    },
  };

  // ─────────────────────────────────────────────────────────────────────
  // Storage layer — Tauri file OR localStorage
  // ─────────────────────────────────────────────────────────────────────

  const STORAGE_KEY = "memoir_v1";
  let _cache = null;

  async function loadData() {
    if (_cache) return _cache;
    let raw = null;
    if (IS_TAURI) {
      try {
        raw = await tauriInvoke("read_store");
      } catch (e) {
        console.warn("[local-api] Tauri read_store failed, falling back", e);
      }
    }
    if (raw === null || raw === undefined) {
      raw = localStorage.getItem(STORAGE_KEY);
    }
    let d;
    try {
      d = raw ? JSON.parse(raw) : null;
    } catch {
      d = null;
    }
    if (!d || typeof d !== "object") d = freshData();
    d.notes ??= [];
    d.tasks ??= [];
    d.events ??= [];
    d.chat ??= [];
    d.preferences ??= { theme: "dark", onboarding_done: false };
    d.settings ??= defaultSettings();
    d.settings = migrateSettings(d.settings);
    // Strip out empty categories (migration from old seed-15 versions)
    const used = new Set(d.notes.map((n) => n.category).filter(Boolean));
    d.categories = (d.categories || []).filter((c) => used.has(c));
    _cache = d;
    return d;
  }

  async function saveData(d) {
    _cache = d;
    const s = JSON.stringify(d);
    try {
      localStorage.setItem(STORAGE_KEY, s);
    } catch (e) {
      console.warn("[local-api] localStorage write failed", e);
    }
    if (IS_TAURI) {
      try {
        await tauriInvoke("write_store", { contents: s });
      } catch (e) {
        console.warn("[local-api] Tauri write_store failed", e);
      }
    }
  }

  function freshData() {
    return {
      notes: [],
      tasks: [],
      events: [],
      categories: [],
      chat: [],
      preferences: { theme: "dark", onboarding_done: false },
      settings: defaultSettings(),
    };
  }

  function defaultSettings() {
    return {
      provider: "gemini",
      api_key: "",
      model: PROVIDERS.gemini.defaultModel,
      ollama_url: "http://localhost:11434",
    };
  }

  // Migrate users off deprecated Gemini models. Google removed gemini-1.5-*
  // from new API keys in late 2025, and gemini-2.0-flash has free_tier=0 for
  // some regions. gemini-2.5-flash is the current recommended model.
  const DEPRECATED_GEMINI_MODELS = new Set([
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-1.5-pro",
    "gemini-1.5-pro-latest",
    "gemini-pro",
  ]);
  function migrateSettings(settings) {
    if (settings.provider === "gemini" && DEPRECATED_GEMINI_MODELS.has(settings.model)) {
      settings.model = "gemini-2.5-flash";
    }
    return settings;
  }

  function uuid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public settings API (used by the settings modal)
  // ─────────────────────────────────────────────────────────────────────

  async function getSettings() {
    const d = await loadData();
    return { ...d.settings };
  }

  async function updateSettings(partial) {
    const d = await loadData();
    d.settings = { ...d.settings, ...partial };
    await saveData(d);
    return d.settings;
  }

  window.memoirLocal = {
    PROVIDERS,
    isTauri: IS_TAURI,
    getSettings,
    updateSettings,
    exportData: async () => JSON.stringify(await loadData(), null, 2),
    importData: async (json) => {
      const d = JSON.parse(json);
      _cache = null;
      await saveData(d);
    },
    clearAll: async () => {
      _cache = null;
      localStorage.removeItem(STORAGE_KEY);
      if (IS_TAURI) {
        try {
          await tauriInvoke("write_store", { contents: "{}" });
        } catch {}
      }
    },
  };

  // ─────────────────────────────────────────────────────────────────────
  // AI — provider adapters (Gemini default)
  // ─────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────
  // Tool declarations — one per intent, reused across all 4 providers
  //
  // Each tool's description explains WHEN to use it with concrete triggers
  // and a distinction from adjacent tools. Parameters use JSON Schema.
  // Every tool includes a `confidence` param (0.0-1.0) so the model self-
  // reports certainty for confidence-gated execution.
  // ─────────────────────────────────────────────────────────────────────

  const SCHEMA_CONFIDENCE = {
    type: "number",
    description:
      "Your confidence in this classification from 0.0 to 1.0. Use 0.95+ when the intent is obvious. Use 0.7-0.9 when the intent is likely but ambiguous. Use 0.4-0.7 when you had to guess. Use < 0.4 only if you really don't know.",
  };

  const NOTE_CATEGORIES = [
    "work", "personal", "ideas", "health", "finance", "learning",
    "travel", "projects", "research", "tech", "entertainment",
    "food", "shopping", "music", "reading",
  ];

  const TOOLS = [
    {
      name: "create_task",
      description:
        "Create a new task — something the user needs to do. Use for ANY imperative action: 'post on X', 'email John', 'buy milk', 'call dentist', 'write blog post', 'fix the bug', 'review the PR', 'remind me to X', 'todo: X', 'X by Friday'. Does NOT require a date/time. When in doubt between create_task and create_note, ask: is the user telling me something they WILL DO (task) or something they KNOW (note)? Default to create_task for imperative phrases.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short action-oriented title, max 60 chars." },
          description: { type: "string", description: "Optional details or context for the task." },
          due_date: { type: "string", description: "Due date in ISO YYYY-MM-DD format. Omit if not mentioned." },
          due_time: { type: "string", description: "Due time in 24-hour HH:MM format, e.g. 18:00. Omit if not mentioned." },
          priority: { type: "integer", description: "1=highest, 5=lowest. Default 3." },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["title", "confidence"],
      },
    },
    {
      name: "create_event",
      description:
        "Create a calendar event at a specific date AND time. Use for: meetings ('meeting with Sarah tomorrow 3pm'), appointments ('haircut at 3pm saturday', 'dentist friday 10am', 'doctor wednesday'), social events ('dinner with Alex 7pm'), classes ('yoga wednesday 6pm'), flights, and anything scheduled with another person or at a location. Solo activities WITH a specific time that recur (gym, yoga, haircut, massage) are also events. If the message describes a deadline or todo rather than a scheduled block of time, use create_task instead.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title, max 60 chars." },
          date: { type: "string", description: "Date in ISO YYYY-MM-DD format." },
          start_time: { type: "string", description: "Start time in 24-hour HH:MM format." },
          end_time: { type: "string", description: "End time in HH:MM format. Omit if unknown." },
          location: { type: "string", description: "Where the event takes place." },
          description: { type: "string", description: "Optional details." },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["title", "date", "confidence"],
      },
    },
    {
      name: "create_note",
      description:
        "Save a thought, idea, observation, fact, or piece of info the user wants to remember. NOT an action — if it describes something to do, use create_task instead. Examples: 'idea — build a reddit scraper', 'react 19 uses a new compiler', 'market closed green today', 'TIL: cmd+shift+. shows hidden files', 'recipe: pasta carbonara ...'. When in doubt between create_note and create_task, ask: is the user telling me something they KNOW (note) or something they WILL DO (task)?",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short descriptive title, max 60 chars." },
          content: { type: "string", description: "The note body. Lightly polish (fix grammar/typos) but preserve the user's voice." },
          category: {
            type: "string",
            enum: NOTE_CATEGORIES,
            description: "Pick the best-fitting category from the enum.",
          },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["title", "content", "category", "confidence"],
      },
    },
    {
      name: "create_bookmark",
      description:
        "Save a URL for later reading. Use when the message contains an http(s):// URL or says 'save this link', 'bookmark this'. If the user says 'post a link to https://... on linkedin', that is a task (create_task), not a bookmark.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to save." },
          title: { type: "string", description: "A descriptive title for the bookmark." },
          description: { type: "string", description: "Optional context or why the user is saving it." },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["url", "title", "confidence"],
      },
    },
    {
      name: "update_task",
      description:
        "Modify an existing task. Use when the user says 'change X to Y', 'move that to Friday', 'push it back', 'rename it', 'mark done', 'actually 6pm instead', 'wait, make it tuesday', 'make it high priority'. You MUST set target_id from the LAST TOUCHED context in the context block. Only include fields the user is actually changing — leave others out. If there is NO LAST TOUCHED context, do NOT call this tool — use respond_conversationally to ask which task.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string", description: "The id of the task to update. Use the LAST TOUCHED id from context." },
          title: { type: "string" },
          description: { type: "string" },
          due_date: { type: "string", description: "ISO YYYY-MM-DD." },
          due_time: { type: "string", description: "HH:MM 24-hour." },
          priority: { type: "integer" },
          done: { type: "boolean", description: "Mark the task as complete (true) or incomplete (false)." },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["target_id", "confidence"],
      },
    },
    {
      name: "update_event",
      description:
        "Modify an existing event. Use for 'change the time', 'move it to friday', 'actually 7pm', 'change location', 'rename it'. You MUST set target_id from the LAST TOUCHED context. If no LAST TOUCHED, use respond_conversationally to ask.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string", description: "The id of the event to update. Use the LAST TOUCHED id from context." },
          title: { type: "string" },
          date: { type: "string", description: "ISO YYYY-MM-DD." },
          start_time: { type: "string", description: "HH:MM 24-hour." },
          end_time: { type: "string" },
          location: { type: "string" },
          description: { type: "string" },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["target_id", "confidence"],
      },
    },
    {
      name: "update_note",
      description:
        "Rename, recategorize, or fully REPLACE the content of an existing note. Use for 'rename it', 'put that in work instead' (change category), 'actually the content should be X' (full rewrite). You MUST set target_id from the LAST TOUCHED context. For ADDING to a note without replacing, use append_to_note instead.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string", description: "The id of the note to update." },
          title: { type: "string" },
          content: { type: "string" },
          category: { type: "string", enum: NOTE_CATEGORIES },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["target_id", "confidence"],
      },
    },
    {
      name: "append_to_note",
      description:
        "APPEND new content to an existing note without replacing it. This is how you GROUP related information into one note. Use this tool aggressively: if the user is sending another message that is clearly a continuation of a note from the RECENT NOTES context (same topic, same person, same theme, explicitly references it, or is an obvious follow-up), DO NOT create a new note — append to the existing one instead. Examples: two quotes about the same person → same note. A fact and then additional context about the same fact → same note. A recipe and then more ingredients → same note. A list being built up over multiple messages → same note. Match against RECENT NOTES by title AND content preview. Set target_id to the id of the existing note you're appending to.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string", description: "The id of the EXISTING note to append to (from RECENT NOTES in context)." },
          content: { type: "string", description: "The new content to append. Will be added as a new paragraph below the existing content." },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["target_id", "content", "confidence"],
      },
    },
    {
      name: "delete_task",
      description:
        "Delete an existing task. Use for 'delete that', 'nevermind', 'scratch that', 'cancel that task', 'remove it', 'undo that'. You MUST set target_id from the LAST TOUCHED context. If no LAST TOUCHED, use respond_conversationally to ask which task.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string", description: "The id of the task to delete." },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["target_id", "confidence"],
      },
    },
    {
      name: "delete_event",
      description: "Delete an existing event. Same pattern as delete_task. Set target_id from LAST TOUCHED.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string" },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["target_id", "confidence"],
      },
    },
    {
      name: "delete_note",
      description: "Delete an existing note. Same pattern as delete_task. Set target_id from LAST TOUCHED.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string" },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["target_id", "confidence"],
      },
    },
    {
      name: "search_notes",
      description:
        "Search the user's saved notes/tasks/events. Use when they ask about their OWN content: 'what did I write about X?', 'show me my health notes', 'find my ideas about AI', 'do I have notes on typescript?', 'what tasks do I have due this week?'. This is for queries OVER the user's stored items.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query to match against notes/tasks/events." },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["query", "confidence"],
      },
    },
    {
      name: "respond_conversationally",
      description:
        "Reply without creating or modifying anything. Use for: greetings ('hi', 'hello', 'thanks'), general questions about the world NOT about the user's own notes ('what is rust?', 'explain closures'), acknowledgements, AND for when an update/delete was requested but there is NO LAST TOUCHED context in the provided context block (ask 'which item?'). NEVER silently drop something the user clearly wanted saved.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Your reply to the user. Markdown allowed." },
          confidence: SCHEMA_CONFIDENCE,
        },
        required: ["message", "confidence"],
      },
    },
  ];

  // ─────────────────────────────────────────────────────────────────────
  // System instruction — role + universal rules + few-shot examples
  // ─────────────────────────────────────────────────────────────────────

  function buildSystemInstruction() {
    const today = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    return `You are Memoir, a local-first notes assistant. The user types short natural-language messages. You MUST respond by calling one or more of the provided tools — never by returning plain text without a tool call.

## Universal Rules

- **Always call at least one tool.** Even for greetings or general questions, call respond_conversationally. Never return just text.
- **Multi-intent: if the user expresses two actions in one message, call multiple tools in the same response.** Example: "schedule the meeting tomorrow 3pm and remind me to prep the agenda" → call BOTH create_event AND create_task in one response.
- Today is ${today}. Tomorrow is ${tomorrow}.
- Dates: always ISO YYYY-MM-DD format.
- Times: always 24-hour HH:MM format. "6pm" → "18:00", "9am" → "09:00", "noon" → "12:00".
- Every tool call MUST include a \`confidence\` number (0.0-1.0). Be honest.

## Intent Boundaries (read carefully)

**create_task vs create_note** — the key question: "is the user telling me something they KNOW, or something they WILL DO?"
- KNOW → create_note ("react 19 uses a new compiler", "S&P closed green", "idea: podcast summarizer")
- WILL DO → create_task ("post on X", "email John", "call dentist", "build an AI agent")

**CRITICAL bias-correction**: when the user's message STARTS with a bare verb in imperative/infinitive form (build, make, create, write, design, ship, fix, set up, add, implement, refactor, deploy, investigate, research, review, check, test, launch, publish, draft, send, schedule, organize, plan), it is ALMOST CERTAINLY a task — NOT a note, NOT an idea. Even if the sentence describes something elaborate or creative like "build an AI agent that reads reddits", it is still a TASK because the user is declaring intent to do it. The only exception is if the user explicitly prefixes with "idea:" or "thought:" — then it is a note about an idea they're considering.

**create_task vs create_event** — both can have dates.
- Appointments, meetings, social at a specific time → create_event
- Deadlines, todos, things due by a date → create_task
- When someone has a specific time-of-day they plan to be doing something with others or at a location → create_event
- Solo scheduled recurring activity (gym at 6am, yoga wednesday 6pm, haircut) → create_event

**update_* vs create_*** — coreference rule:
- If LAST TOUCHED context exists AND the user uses "it" / "that" / "the time" / "change" / "move" / "push" / "rename" / "make it" / "instead" / "actually" → use update_*
- If NO LAST TOUCHED context AND the user says "change the time" or "delete that" → use respond_conversationally to ask "which item?". NEVER invent a target_id.

**append_to_note vs create_note** — GROUPING rule (critical for quality):
When the user sends a note, check the RECENT NOTES context carefully. If the new content is **clearly about the same topic, same person, same theme, or is an obvious continuation** of a recent note, call append_to_note with that note's id instead of creating a new one. This is how Memoir builds up coherent notes from multiple short messages.

Be aggressive about grouping. Signals of "same note":
- Both mention the same specific person, company, or entity (e.g. two quotes from Sam Altman)
- Same specific topic (e.g. both about "A.G.I. Manhattan Project analogy")
- User explicitly references the prior note ("also about X...", "adding to that...", "another thing about X...")
- Same list being built ("groceries: milk" then "and bread" → append)
- Same recipe, same project, same research thread

Only use create_note when the topic is genuinely different from everything in RECENT NOTES.

When appending, the target_id MUST come from RECENT NOTES in the context block. Do not invent ids.

## Few-Shot Examples

Input: "post on X about the new Memoir launch"
→ create_task(title="Post on X about the new Memoir launch", confidence=0.95)

Input: "build an AI agent that reads relevant reddits"
→ create_task(title="Build an AI agent that reads relevant reddits", confidence=0.95)
(NOT create_note. "Build X" is a task — the user is declaring they want to do it. An idea-note would say "idea: X" or "thought: X".)

Input: "design a new onboarding flow for the app"
→ create_task(title="Design a new onboarding flow for the app", confidence=0.95)

Input: "set up monitoring for the API endpoints"
→ create_task(title="Set up monitoring for the API endpoints", confidence=0.95)

Input: "idea: an AI that grades reddit comments"
→ create_note(title="AI that grades reddit comments", content="Idea: an AI that grades reddit comments.", category="ideas", confidence=0.95)
(Note the explicit "idea:" prefix — THAT'S when you pick create_note instead of create_task.)

Input: "remind me to call mom tomorrow at 3pm"
→ create_task(title="Call mom", due_date="${tomorrow}", due_time="15:00", confidence=0.98)

Input: "pay rent"
→ create_task(title="Pay rent", confidence=0.96)

Input: "meeting with Sarah tomorrow 3pm"
→ create_event(title="Meeting with Sarah", date="${tomorrow}", start_time="15:00", confidence=0.97)

Input: "haircut at 3pm saturday"
→ create_event(title="Haircut", date="<next saturday>", start_time="15:00", confidence=0.95)

Input: "dentist at 2pm next tuesday"
→ create_event(title="Dentist", date="<next tuesday>", start_time="14:00", confidence=0.96)

Input: "report due by 5pm friday"
→ create_task(title="Report", due_date="<next friday>", due_time="17:00", confidence=0.95)

Input: "idea — AI that summarizes podcasts"
→ create_note(title="AI podcast summarizer", content="Idea: AI that summarizes podcasts.", category="ideas", confidence=0.95)

Input: "react 19 uses a new compiler"
→ create_note(title="React 19 uses a new compiler", content="React 19 uses a new compiler.", category="tech", confidence=0.95)

[CONTEXT: RECENT NOTES include id="n4" title="Sam Altman: Manhattan Project for AI" content="Altman has continued to compare the quest for AGI to the Manhattan Project..."]
Input: "Over the years, Altman has continued to compare the quest for AGI to the Manhattan Project. Like Oppenheimer, who used impassioned appeals..."
→ append_to_note(target_id="n4", content="Over the years, Altman has continued to compare the quest for AGI to the Manhattan Project. Like Oppenheimer, who used impassioned appeals...", confidence=0.93)
(Reason: same topic — both quotes about Altman's AGI/Manhattan Project analogy. Append to the existing note rather than creating a duplicate.)

[CONTEXT: RECENT NOTES include id="n5" title="Groceries" content="- milk\n- eggs"]
Input: "and bread and oranges"
→ append_to_note(target_id="n5", content="- bread\n- oranges", confidence=0.96)
(Reason: obvious continuation of the groceries list.)

Input: "https://nytimes.com/article-about-ai"
→ create_bookmark(url="https://nytimes.com/article-about-ai", title="NYT article about AI", confidence=0.98)

Input: "schedule the standup tomorrow 9am and remind me to prep the agenda"
→ create_event(title="Standup", date="${tomorrow}", start_time="09:00", confidence=0.95)
  AND create_task(title="Prep the standup agenda", due_date="${tomorrow}", confidence=0.92)

[CONTEXT: LAST TOUCHED is task id="t7" title="Post on X about Memoir launch" due_date="${tomorrow}" due_time="16:00"]
Input: "change timing to 6pm instead"
→ update_task(target_id="t7", due_time="18:00", confidence=0.97)

[CONTEXT: LAST TOUCHED is task id="t8" title="submit report" due_date="${tomorrow}"]
Input: "actually, move it to friday"
→ update_task(target_id="t8", due_date="<next friday>", confidence=0.94)

[CONTEXT: LAST TOUCHED is task id="t9" title="buy groceries"]
Input: "mark it done"
→ update_task(target_id="t9", done=true, confidence=0.97)

[CONTEXT: NO LAST TOUCHED]
Input: "change the time to 6pm"
→ respond_conversationally(message="Which item did you want to change? I don't see a recent one.", confidence=0.9)

[CONTEXT: LAST TOUCHED is task id="t10"]
Input: "nevermind, delete that"
→ delete_task(target_id="t10", confidence=0.98)

Input: "what did I write about react last week?"
→ search_notes(query="react", confidence=0.95)

Input: "what is rust programming language?"
→ respond_conversationally(message="Rust is a systems programming language focused on safety, speed, and concurrency...", confidence=0.98)

Input: "hello"
→ respond_conversationally(message="Hi! What can I help you capture?", confidence=0.99)

Input: "thanks"
→ respond_conversationally(message="You got it.", confidence=0.99)`;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Context block — appended to system instruction OR user message per provider
  // ─────────────────────────────────────────────────────────────────────

  function buildContextBlock(contextData) {
    if (!contextData) return "";
    const lines = [];
    if (contextData.lastTouched) {
      const lt = contextData.lastTouched;
      lines.push("## Conversation Context");
      lines.push("");
      lines.push("**LAST TOUCHED** (the user's most recent action — if they say \"it\", \"that\", \"change X\", they probably mean this):");
      lines.push("- type: " + lt.type);
      lines.push("- id: " + lt.id);
      lines.push("- title: " + JSON.stringify(lt.title || ""));
      if (lt.due_date) lines.push("- due_date: " + lt.due_date);
      if (lt.due_time) lines.push("- due_time: " + lt.due_time);
      if (lt.date) lines.push("- date: " + lt.date);
      if (lt.start_time) lines.push("- start_time: " + lt.start_time);
      if (lt.category) lines.push("- category: " + lt.category);
    } else {
      lines.push("## Conversation Context");
      lines.push("");
      lines.push("**LAST TOUCHED**: none (this is the start of the conversation or the user has not created anything recently). If the user says 'change it' / 'delete that' / 'update the time' without context, use respond_conversationally to ask which item.");
    }
    if (contextData.recentNotes && contextData.recentNotes.length) {
      lines.push("");
      lines.push("**RECENT NOTES** (consider append_to_note if the user's message is about the same topic/person/theme):");
      for (const n of contextData.recentNotes) {
        const preview = (n.content || "").replace(/\s+/g, " ").slice(0, 140);
        lines.push(`- [${n.id}] cat=${n.category} ${JSON.stringify(n.title)}`);
        if (preview) lines.push(`    preview: ${JSON.stringify(preview)}`);
      }
    }
    if (contextData.recentTasks && contextData.recentTasks.length) {
      lines.push("");
      lines.push("**RECENT TASKS**:");
      for (const t of contextData.recentTasks) {
        lines.push(`- [${t.id}] ${JSON.stringify(t.title)} due=${t.due_date || "none"} ${t.due_time || ""} ${t.done ? "(done)" : ""}`);
      }
    }
    if (contextData.recentEvents && contextData.recentEvents.length) {
      lines.push("");
      lines.push("**RECENT EVENTS**:");
      for (const e of contextData.recentEvents) {
        lines.push(`- [${e.id}] ${JSON.stringify(e.title)} on ${e.date} ${e.start_time || ""}`);
      }
    }
    return "\n\n" + lines.join("\n");
  }

  // ─────────────────────────────────────────────────────────────────────
  // Layer 1 — rule-based early exits (skip LLM entirely)
  // ─────────────────────────────────────────────────────────────────────

  const PURE_URL_REGEX = /^\s*(https?:\/\/\S+)\s*$/i;

  function tryRuleBasedClassify(userMessage, _contextData) {
    // Rule 1: Message is ONLY a URL → create_bookmark, skip LLM
    const m = userMessage.match(PURE_URL_REGEX);
    if (m) {
      const url = m[1];
      let title = url;
      try {
        const u = new URL(url);
        title = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
        if (title.length > 60) title = title.slice(0, 57) + "...";
      } catch {}
      return {
        tool_calls: [{ name: "create_bookmark", args: { url, title, confidence: 0.99 } }],
        raw_text: "",
        source: "rule",
      };
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Per-provider tool-format translators
  // ─────────────────────────────────────────────────────────────────────

  function toolsForGemini() {
    return TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  function toolsForOpenAI() {
    return TOOLS.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  function toolsForAnthropic() {
    return TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  function toolsForOllama() {
    return TOOLS.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  // Pull a human-readable message out of a provider error response.
  function extractProviderError(rawText) {
    try {
      const parsed = JSON.parse(rawText);
      return (
        parsed?.error?.message ||
        parsed?.error?.status ||
        parsed?.message ||
        rawText.slice(0, 200)
      );
    } catch {
      return rawText.slice(0, 200);
    }
  }

  // Turn a raw HTTP error into a classified, user-friendly Error.
  // We tag it with a .kind so the UI can show helpful advice.
  function classifyProviderError(status, rawText, provider) {
    const msg = extractProviderError(rawText);
    const lower = (msg + " " + rawText).toLowerCase();
    const err = new Error(msg);
    err.provider = provider;
    err.status = status;
    if (status === 401 || status === 403 || lower.includes("api key not valid") || lower.includes("invalid api key") || lower.includes("incorrect api key")) {
      err.kind = "invalid_key";
    } else if (status === 404 || lower.includes("is not found for api version") || lower.includes("model not found") || lower.includes("does not exist")) {
      err.kind = "model_not_found";
    } else if (status === 429 || lower.includes("quota") || lower.includes("resource_exhausted") || lower.includes("rate limit")) {
      err.kind = "quota";
    } else if (status >= 500) {
      err.kind = "server";
    } else {
      err.kind = "other";
    }
    return err;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Provider adapters — function calling
  //
  // All four adapters return a normalized shape:
  //   { tool_calls: [{ name, args }], raw_text: string, source: "llm" }
  // ─────────────────────────────────────────────────────────────────────

  async function callGemini(userMessage, settings, contextData) {
    if (!settings.api_key) throw new Error("NO_KEY");
    const model = settings.model || PROVIDERS.gemini.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.api_key)}`;

    // Gemini: inject context as an initial user-turn BEFORE the message,
    // since system_instruction doesn't update per-request.
    const contextText = buildContextBlock(contextData);
    const userText = contextText
      ? contextText + "\n\n---\n\nUser says: " + userMessage
      : userMessage;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        tools: [{ functionDeclarations: toolsForGemini() }],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { temperature: 0.3 },
      }),
    });
    if (!res.ok) throw classifyProviderError(res.status, await res.text(), "gemini");
    const out = await res.json();
    const parts = out.candidates?.[0]?.content?.parts || [];
    const tool_calls = [];
    let raw_text = "";
    for (const p of parts) {
      if (p.functionCall) {
        tool_calls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
      } else if (p.text) {
        raw_text += p.text;
      }
    }
    return { tool_calls, raw_text, source: "llm" };
  }

  async function callOpenAI(userMessage, settings, contextData) {
    if (!settings.api_key) throw new Error("NO_KEY");
    const model = settings.model || PROVIDERS.openai.defaultModel;
    const contextText = buildContextBlock(contextData);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.api_key,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildSystemInstruction() + contextText },
          { role: "user", content: userMessage },
        ],
        tools: toolsForOpenAI(),
        tool_choice: "required",
        parallel_tool_calls: true,
        temperature: 0.3,
      }),
    });
    if (!res.ok) throw classifyProviderError(res.status, await res.text(), "openai");
    const out = await res.json();
    const message = out.choices?.[0]?.message || {};
    const tool_calls = (message.tool_calls || []).map((tc) => {
      let args = {};
      try {
        args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments || {};
      } catch {}
      return { name: tc.function.name, args };
    });
    return { tool_calls, raw_text: message.content || "", source: "llm" };
  }

  async function callAnthropic(userMessage, settings, contextData) {
    if (!settings.api_key) throw new Error("NO_KEY");
    const model = settings.model || PROVIDERS.anthropic.defaultModel;
    const contextText = buildContextBlock(contextData);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.api_key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: buildSystemInstruction() + contextText,
        messages: [{ role: "user", content: userMessage }],
        tools: toolsForAnthropic(),
        tool_choice: { type: "any" },
      }),
    });
    if (!res.ok) throw classifyProviderError(res.status, await res.text(), "anthropic");
    const out = await res.json();
    const tool_calls = [];
    let raw_text = "";
    for (const block of out.content || []) {
      if (block.type === "tool_use") {
        tool_calls.push({ name: block.name, args: block.input || {} });
      } else if (block.type === "text") {
        raw_text += block.text || "";
      }
    }
    return { tool_calls, raw_text, source: "llm" };
  }

  async function callOllama(userMessage, settings, contextData) {
    const baseUrl = (settings.ollama_url || "http://localhost:11434").replace(/\/$/, "");
    const model = settings.model || PROVIDERS.ollama.defaultModel;
    const contextText = buildContextBlock(contextData);
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildSystemInstruction() + contextText },
          { role: "user", content: userMessage },
        ],
        tools: toolsForOllama(),
        stream: false,
        options: { temperature: 0.3 },
      }),
    });
    if (!res.ok) throw classifyProviderError(res.status, await res.text(), "ollama");
    const out = await res.json();
    const msg = out.message || {};
    const tool_calls = (msg.tool_calls || []).map((tc) => {
      const fn = tc.function || {};
      let args = fn.arguments || tc.arguments || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      return { name: fn.name || tc.name, args };
    });
    return { tool_calls, raw_text: msg.content || "", source: "llm" };
  }

  const PROVIDER_ADAPTERS = {
    gemini: callGemini,
    openai: callOpenAI,
    anthropic: callAnthropic,
    ollama: callOllama,
  };

  // ─────────────────────────────────────────────────────────────────────
  // classifyIntent — rule preprocessor → LLM → retry-once
  // ─────────────────────────────────────────────────────────────────────

  async function classifyIntent(userMessage, settings, contextData) {
    // Layer 1: rule-based early exits (skip LLM entirely where possible)
    const ruleResult = tryRuleBasedClassify(userMessage, contextData);
    if (ruleResult) return ruleResult;

    // Layer 2: LLM dispatch
    const adapter = PROVIDER_ADAPTERS[settings.provider] || PROVIDER_ADAPTERS.gemini;
    let result = await adapter(userMessage, settings, contextData);

    // Layer 3: Retry once if the model produced no tool calls
    if (!result.tool_calls || result.tool_calls.length === 0) {
      debugLog("classifyIntent: no tool calls on first try, retrying");
      const retryMsg =
        userMessage +
        "\n\n(System note: your previous response did not call any tool. You MUST call exactly one tool. If the user is just making conversation, call respond_conversationally.)";
      result = await adapter(retryMsg, settings, contextData);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Persisted last-touched context (survives app reload via localStorage)
  // ─────────────────────────────────────────────────────────────────────

  const LAST_TOUCHED_KEY = "memoir_last_touched";

  function loadLastTouched() {
    try {
      const raw = localStorage.getItem(LAST_TOUCHED_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveLastTouched(type, item) {
    const x = {
      type,
      id: item.id,
      title: item.title || "",
      due_date: item.due_date,
      due_time: item.due_time,
      date: item.date,
      start_time: item.start_time,
      category: item.category,
      touched_at: nowIso(),
    };
    try { localStorage.setItem(LAST_TOUCHED_KEY, JSON.stringify(x)); } catch {}
  }

  function clearLastTouched() {
    try { localStorage.removeItem(LAST_TOUCHED_KEY); } catch {}
  }

  // ─────────────────────────────────────────────────────────────────────
  // Intent handlers
  // ─────────────────────────────────────────────────────────────────────

  function friendlyErrorMessage(e, settings) {
    const provider = e.provider || settings.provider;
    const providerLabel = PROVIDERS[provider]?.label || provider;
    const model = settings.model || "";

    if (e.kind === "invalid_key") {
      return `**${providerLabel} rejected your API key.** Double-check it in Settings — it should start with \`sk-\` (OpenAI), \`sk-ant-\` (Anthropic), or be a long alphanumeric string (Gemini).`;
    }

    if (e.kind === "model_not_found") {
      return (
        `**The model \`${model}\` isn't available on your ${providerLabel} key.** ` +
        `This usually means Google deprecated it. Open **Settings** and pick a different model from the dropdown — ` +
        `**Gemini 2.5 Flash** is the current recommendation.`
      );
    }

    if (e.kind === "quota") {
      // Gemini-specific: "limit: 0" on 2.0-flash is not a real rate limit,
      // it's a missing-quota-allocation issue. Switching models fixes it.
      if (provider === "gemini" && model.includes("2.0")) {
        return (
          `**Gemini 2.0 Flash isn't available on the free tier for your account.** ` +
          `This is a Google-side restriction (regional / account-type). ` +
          `Open **Settings** and switch the model to **Gemini 1.5 Flash** — it has universal free tier access.`
        );
      }
      return (
        `**${providerLabel} rate limit hit.** ` +
        (provider === "gemini"
          ? "Free tier is ~50 requests/day and ~20/minute. Wait a minute and try again, or upgrade at https://aistudio.google.com."
          : provider === "openai"
          ? "Check your usage at https://platform.openai.com/usage — you may have run out of credits."
          : provider === "anthropic"
          ? "Check your usage at https://console.anthropic.com/settings/usage."
          : "Try again in a moment.")
      );
    }

    if (e.kind === "server") {
      return `**${providerLabel} is having issues right now** (HTTP ${e.status}). Try again in a minute.`;
    }

    // Generic fallback — show the parsed provider message, not raw JSON
    const msg = (e.message || String(e)).slice(0, 300);
    return `**${providerLabel} error:** ${msg}`;
  }

  // ─────────────────────────────────────────────────────────────────────
  // handleMessage — main orchestrator. Layer 0/4/5 from the architecture.
  // ─────────────────────────────────────────────────────────────────────

  async function handleMessage(userMessage) {
    // Layer 0 — validation
    if (!userMessage || !userMessage.trim()) {
      return { type: "chat_response", message: "Say something." };
    }

    const data = await loadData();
    const settings = data.settings;
    const providerDef = PROVIDERS[settings.provider] || PROVIDERS.gemini;

    if (providerDef.needsKey && !settings.api_key) {
      return {
        type: "chat_response",
        message:
          "Welcome! Open **Settings** (profile menu → Settings) and add your API key to get started. " +
          `Memoir uses **${providerDef.label}** by default — it has a generous free tier.`,
      };
    }

    // Build conversation context: last-touched item (persisted!) + recent items.
    // recentNotes is critical for append_to_note — the model needs to see titles
    // AND content previews to judge whether a new message is about an existing topic.
    const contextData = {
      lastTouched: loadLastTouched(),
      recentNotes: (data.notes || [])
        .filter((n) => !n.is_bookmark)
        .slice(0, 8)
        .map((n) => ({
          id: n.id,
          title: n.title,
          category: n.category,
          content: n.content,
        })),
      recentTasks: (data.tasks || []).slice(0, 5).map((t) => ({
        id: t.id, title: t.title, due_date: t.due_date, due_time: t.due_time, done: t.done,
      })),
      recentEvents: (data.events || []).slice(0, 5).map((e) => ({
        id: e.id, title: e.title, date: e.date, start_time: e.start_time,
      })),
    };

    // Layer 2/3 — classify via rule preprocessor → LLM → retry
    let result;
    try {
      result = await classifyIntent(userMessage, settings, contextData);
    } catch (e) {
      if (e.message === "NO_KEY") {
        return { type: "chat_response", message: "No API key set. Open **Settings** in the profile menu." };
      }
      return { type: "chat_response", message: friendlyErrorMessage(e, settings) };
    }

    // If the model still produced no tool call after retry, fall back to the raw text
    if (!result.tool_calls || result.tool_calls.length === 0) {
      return {
        type: "chat_response",
        message: result.raw_text
          ? result.raw_text
          : "I wasn't sure how to handle that. Try rephrasing?",
      };
    }

    // Execute each tool call in order, collecting cards
    const cards = [];
    for (const call of result.tool_calls) {
      try {
        const card = await executeToolCall(call, data);
        if (card) cards.push(card);
      } catch (e) {
        debugLog("executeToolCall error: " + (e && e.message));
        cards.push({ type: "chat_response", message: "Couldn't complete one of the actions: " + (e && e.message) });
      }
    }

    // Persist data once after all tool calls are applied
    await saveData(data);

    // Return single card if only one, else multi_result wrapping all cards
    if (cards.length === 0) {
      return { type: "chat_response", message: "Done." };
    }
    if (cards.length === 1) {
      return cards[0];
    }
    return { type: "multi_result", results: cards };
  }

  // ─────────────────────────────────────────────────────────────────────
  // executeToolCall — apply one tool call to `data`, return a frontend card.
  // Mutates `data` in place; caller saves once at the end.
  //
  // Confidence tiers:
  //   confidence >= 0.85 → apply silently, return normal card
  //   0.6 <= confidence < 0.85 → apply + wrap as needs_confirmation
  //   confidence < 0.6 → apply + wrap as needs_clarification (ask user)
  // ─────────────────────────────────────────────────────────────────────

  async function executeToolCall(call, data) {
    const name = call.name;
    const args = call.args || {};
    const confidence = typeof args.confidence === "number" ? args.confidence : 0.9;

    switch (name) {
      case "create_task": {
        const task = {
          id: uuid(),
          title: args.title || "Untitled task",
          description: args.description || "",
          due_date: args.due_date || null,
          due_time: args.due_time || null,
          priority: args.priority || 3,
          project: null,
          labels: [],
          done: false,
          created: nowIso(),
        };
        data.tasks.unshift(task);
        saveLastTouched("task", task);
        return wrapByConfidence({
          type: "task_created",
          id: task.id,
          title: task.title,
          description: task.description,
          due_date: task.due_date,
          due_time: task.due_time,
          priority: task.priority,
        }, confidence);
      }

      case "create_event": {
        const ev = {
          id: uuid(),
          title: args.title || "Untitled event",
          date: args.date || new Date().toISOString().split("T")[0],
          end_date: null,
          start_time: args.start_time || null,
          end_time: args.end_time || null,
          all_day: !args.start_time,
          location: args.location || "",
          description: args.description || "",
          color: null,
        };
        data.events.unshift(ev);
        saveLastTouched("event", ev);
        return wrapByConfidence({
          type: "event_created",
          id: ev.id,
          title: ev.title,
          date: ev.date,
          start_time: ev.start_time,
          end_time: ev.end_time,
          location: ev.location,
        }, confidence);
      }

      case "create_note": {
        const note = {
          id: uuid(),
          category: args.category || "personal",
          title: args.title || "Untitled note",
          content: args.content || "",
          created: nowIso(),
          updated: nowIso(),
        };
        data.notes.unshift(note);
        if (!data.categories.includes(note.category)) data.categories.push(note.category);
        saveLastTouched("note", note);
        return wrapByConfidence({
          type: "note_saved",
          id: note.id,
          category: note.category,
          title: note.title,
          content: note.content,
          summary: "",
        }, confidence);
      }

      case "create_bookmark": {
        const bm = {
          id: uuid(),
          category: "reading",
          title: args.title || args.url || "Bookmark",
          content: args.description || args.url || "",
          url: args.url || "",
          created: nowIso(),
          updated: nowIso(),
          is_bookmark: true,
        };
        data.notes.unshift(bm);
        if (!data.categories.includes("reading")) data.categories.push("reading");
        saveLastTouched("note", bm);
        return wrapByConfidence({
          type: "bookmark_saved",
          id: bm.id,
          bookmark_url: bm.url,
          bookmark_title: bm.title,
          bookmark_description: bm.content,
          bookmark_type: "website",
        }, confidence);
      }

      case "update_task": {
        const lt = loadLastTouched();
        const targetId = args.target_id || (lt && lt.type === "task" ? lt.id : null);
        const idx = targetId ? data.tasks.findIndex((t) => t.id === targetId) : -1;
        if (idx < 0) {
          return { type: "chat_response", message: "I couldn't figure out which task you meant." };
        }
        const patch = {};
        if (args.title !== undefined && args.title !== "") patch.title = args.title;
        if (args.description !== undefined && args.description !== "") patch.description = args.description;
        if (args.due_date !== undefined && args.due_date !== "") patch.due_date = args.due_date;
        if (args.due_time !== undefined && args.due_time !== "") patch.due_time = args.due_time;
        if (args.priority !== undefined && args.priority !== 0) patch.priority = args.priority;
        if (args.done !== undefined) patch.done = args.done;
        data.tasks[idx] = { ...data.tasks[idx], ...patch };
        saveLastTouched("task", data.tasks[idx]);
        return wrapByConfidence({
          type: "task_created",
          id: data.tasks[idx].id,
          title: data.tasks[idx].title,
          description: data.tasks[idx].description,
          due_date: data.tasks[idx].due_date,
          due_time: data.tasks[idx].due_time,
          priority: data.tasks[idx].priority,
          _updated: true,
        }, confidence);
      }

      case "update_event": {
        const lt = loadLastTouched();
        const targetId = args.target_id || (lt && lt.type === "event" ? lt.id : null);
        const idx = targetId ? data.events.findIndex((e) => e.id === targetId) : -1;
        if (idx < 0) {
          return { type: "chat_response", message: "I couldn't figure out which event you meant." };
        }
        const patch = {};
        if (args.title !== undefined && args.title !== "") patch.title = args.title;
        if (args.date !== undefined && args.date !== "") patch.date = args.date;
        if (args.start_time !== undefined && args.start_time !== "") {
          patch.start_time = args.start_time;
          patch.all_day = false;
        }
        if (args.end_time !== undefined && args.end_time !== "") patch.end_time = args.end_time;
        if (args.location !== undefined && args.location !== "") patch.location = args.location;
        if (args.description !== undefined && args.description !== "") patch.description = args.description;
        data.events[idx] = { ...data.events[idx], ...patch };
        saveLastTouched("event", data.events[idx]);
        return wrapByConfidence({
          type: "event_created",
          id: data.events[idx].id,
          title: data.events[idx].title,
          date: data.events[idx].date,
          start_time: data.events[idx].start_time,
          end_time: data.events[idx].end_time,
          location: data.events[idx].location,
          _updated: true,
        }, confidence);
      }

      case "update_note": {
        const lt = loadLastTouched();
        const targetId = args.target_id || (lt && lt.type === "note" ? lt.id : null);
        const idx = targetId ? data.notes.findIndex((n) => n.id === targetId) : -1;
        if (idx < 0) {
          return { type: "chat_response", message: "I couldn't figure out which note you meant." };
        }
        const patch = { updated: nowIso() };
        if (args.title !== undefined && args.title !== "") patch.title = args.title;
        if (args.content !== undefined && args.content !== "") patch.content = args.content;
        if (args.category !== undefined && args.category !== "") patch.category = args.category;
        data.notes[idx] = { ...data.notes[idx], ...patch };
        saveLastTouched("note", data.notes[idx]);
        return wrapByConfidence({
          type: "note_saved",
          id: data.notes[idx].id,
          category: data.notes[idx].category,
          title: data.notes[idx].title,
          content: data.notes[idx].content,
          _updated: true,
        }, confidence);
      }

      case "append_to_note": {
        const targetId = args.target_id;
        const idx = targetId ? data.notes.findIndex((n) => n.id === targetId) : -1;
        if (idx < 0) {
          // Target not found — fall back to creating a new note so nothing is lost.
          debugLog("append_to_note: target_id " + targetId + " not found; creating new note instead");
          const note = {
            id: uuid(),
            category: "personal",
            title: (args.content || "Note").slice(0, 60),
            content: args.content || "",
            created: nowIso(),
            updated: nowIso(),
          };
          data.notes.unshift(note);
          saveLastTouched("note", note);
          return wrapByConfidence({
            type: "note_saved",
            id: note.id,
            category: note.category,
            title: note.title,
            content: note.content,
          }, confidence);
        }
        const existing = data.notes[idx];
        const newContent = args.content || "";
        // Separator: blank line between paragraphs, single newline between list items.
        const sep = /^[-*•\d]/.test(newContent.trim()) ? "\n" : "\n\n";
        existing.content = (existing.content || "") + sep + newContent;
        existing.updated = nowIso();
        data.notes[idx] = existing;
        saveLastTouched("note", existing);
        return wrapByConfidence({
          type: "note_saved",
          id: existing.id,
          category: existing.category,
          title: existing.title,
          content: existing.content,
          _appended: true,
        }, confidence);
      }

      case "delete_task": {
        const lt = loadLastTouched();
        const targetId = args.target_id || (lt && lt.type === "task" ? lt.id : null);
        const task = targetId ? data.tasks.find((t) => t.id === targetId) : null;
        if (!task) {
          return { type: "chat_response", message: "Couldn't figure out which task to delete." };
        }
        data.tasks = data.tasks.filter((t) => t.id !== targetId);
        if (lt && lt.id === targetId) clearLastTouched();
        return { type: "task_deleted", message: `Deleted task: **${task.title}**` };
      }

      case "delete_event": {
        const lt = loadLastTouched();
        const targetId = args.target_id || (lt && lt.type === "event" ? lt.id : null);
        const ev = targetId ? data.events.find((e) => e.id === targetId) : null;
        if (!ev) {
          return { type: "chat_response", message: "Couldn't figure out which event to delete." };
        }
        data.events = data.events.filter((e) => e.id !== targetId);
        if (lt && lt.id === targetId) clearLastTouched();
        return { type: "event_deleted", message: `Deleted event: **${ev.title}**` };
      }

      case "delete_note": {
        const lt = loadLastTouched();
        const targetId = args.target_id || (lt && lt.type === "note" ? lt.id : null);
        const note = targetId ? data.notes.find((n) => n.id === targetId) : null;
        if (!note) {
          return { type: "chat_response", message: "Couldn't figure out which note to delete." };
        }
        data.notes = data.notes.filter((n) => n.id !== targetId);
        if (lt && lt.id === targetId) clearLastTouched();
        return { type: "chat_response", message: `Deleted note: **${note.title}**` };
      }

      case "search_notes": {
        const q = (args.query || "").toLowerCase();
        const results = data.notes
          .filter(
            (n) =>
              (n.title || "").toLowerCase().includes(q) ||
              (n.content || "").toLowerCase().includes(q) ||
              (n.category || "").toLowerCase().includes(q),
          )
          .slice(0, 10);
        const msg = results.length
          ? `Found ${results.length} note${results.length === 1 ? "" : "s"} matching "${args.query}":`
          : `No notes found matching "${args.query}".`;
        return { type: "search_results", message: msg, results };
      }

      case "respond_conversationally": {
        return { type: "chat_response", message: args.message || "Got it." };
      }

      default:
        debugLog("executeToolCall: unknown tool '" + name + "'");
        return { type: "chat_response", message: `I tried to call an unknown tool (${name}). Try rephrasing?` };
    }
  }

  // Wrap a success card with confidence-tier metadata for the frontend to render.
  // The underlying action has already been applied — this only affects presentation.
  function wrapByConfidence(card, confidence) {
    if (typeof confidence !== "number" || confidence >= 0.85) {
      return card;
    }
    if (confidence >= 0.6) {
      return { ...card, _confidence: confidence, _needs_confirmation: true };
    }
    return { ...card, _confidence: confidence, _needs_clarification: true };
  }

  // ─────────────────────────────────────────────────────────────────────
  // /api/* routing
  // ─────────────────────────────────────────────────────────────────────

  const FAKE_USER = { email: "local@memoir.app", name: "You", picture: null, last_seen: null };

  async function handleApiRequest(pathname, method, body) {
    const data = await loadData();

    if (pathname === "/api/init") {
      const lastSeen = localStorage.getItem("memoir_last_seen");
      localStorage.setItem("memoir_last_seen", nowIso());
      return {
        config: { google_client_id: null, ai_enabled: true },
        user: { ...FAKE_USER, last_seen: lastSeen },
      };
    }
    if (pathname === "/api/auth/me") return { user: FAKE_USER };
    if (pathname.startsWith("/api/auth/")) return { user: FAKE_USER, token: "local" };

    if (pathname === "/api/dashboard") {
      return {
        recent: data.notes.slice(0, 20),
        categories: buildCategoryList(data),
        tasks: data.tasks,
        projects: [],
        events: data.events,
        preferences: data.preferences,
        subscription: { plan: "local", status: "active" },
      };
    }

    if (pathname === "/api/message" && method === "POST") {
      return await handleMessage(body.message || "");
    }

    if (pathname === "/api/categories") return { categories: buildCategoryList(data) };
    if (pathname === "/api/recent") return { notes: data.notes.slice(0, 20) };

    const noteMatch = pathname.match(/^\/api\/note\/([^/]+)$/);
    if (noteMatch) {
      const id = decodeURIComponent(noteMatch[1]);
      if (method === "GET") return data.notes.find((n) => n.id === id) || {};
      if (method === "DELETE") {
        data.notes = data.notes.filter((n) => n.id !== id);
        await saveData(data);
        return { ok: true };
      }
      if (method === "PUT") {
        const i = data.notes.findIndex((n) => n.id === id);
        if (i >= 0) {
          data.notes[i] = { ...data.notes[i], ...body, updated: nowIso() };
          await saveData(data);
        }
        return { ok: true };
      }
    }
    const notesByCatMatch = pathname.match(/^\/api\/notes\/(.+)$/);
    if (notesByCatMatch) {
      const cat = decodeURIComponent(notesByCatMatch[1]);
      return { notes: data.notes.filter((n) => n.category === cat) };
    }

    // Delete an entire notebook (category) — removes all notes in it.
    const categoryMatch = pathname.match(/^\/api\/category\/(.+)$/);
    if (categoryMatch && method === "DELETE") {
      const cat = decodeURIComponent(categoryMatch[1]).toLowerCase();
      const before = data.notes.length;
      data.notes = data.notes.filter((n) => (n.category || "").toLowerCase() !== cat);
      data.categories = (data.categories || []).filter((c) => c.toLowerCase() !== cat);
      // Clear lastTouched if it pointed at a now-deleted note in this category.
      const lt = loadLastTouched();
      if (lt && lt.type === "note" && !data.notes.find((n) => n.id === lt.id)) {
        clearLastTouched();
      }
      await saveData(data);
      return { ok: true, deleted: before - data.notes.length };
    }

    if (pathname === "/api/tasks" && method === "GET") return { tasks: data.tasks };
    if (pathname === "/api/tasks" && method === "POST") {
      const task = { id: uuid(), done: false, created: nowIso(), ...body };
      data.tasks.unshift(task);
      await saveData(data);
      return task;
    }
    if (pathname === "/api/tasks/projects") return { projects: [] };
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      if (method === "PUT") {
        const i = data.tasks.findIndex((t) => t.id === id);
        if (i >= 0) {
          data.tasks[i] = { ...data.tasks[i], ...body };
          await saveData(data);
        }
        return { ok: true };
      }
      if (method === "DELETE") {
        data.tasks = data.tasks.filter((t) => t.id !== id);
        await saveData(data);
        return { ok: true };
      }
    }

    if (pathname === "/api/events" && method === "GET") return { events: data.events };
    if (pathname === "/api/events" && method === "POST") {
      const ev = { id: uuid(), ...body };
      data.events.unshift(ev);
      await saveData(data);
      return ev;
    }

    if (pathname === "/api/preferences") {
      if (method === "GET") return { preferences: data.preferences };
      if (method === "PUT") {
        data.preferences = { ...data.preferences, ...body };
        await saveData(data);
        return { ok: true };
      }
    }

    if (pathname === "/api/chat/history") {
      if (method === "GET") return { messages: data.chat };
      if (method === "PUT") {
        data.chat = body.messages || [];
        await saveData(data);
        return { ok: true };
      }
      if (method === "DELETE") {
        data.chat = [];
        await saveData(data);
        return { ok: true };
      }
    }

    if (pathname === "/api/subscription") return { plan: "local", status: "active" };
    if (pathname === "/api/undo-status") return { can_undo: false, can_redo: false };
    if (pathname === "/api/undo" || pathname === "/api/redo") return { ok: true };
    if (pathname === "/api/health") return { status: "ok" };
    if (pathname === "/api/config") return { ai_enabled: true };
    if (pathname === "/api/feedback") return { ok: true };
    if (pathname === "/api/export") return data;
    if (pathname === "/api/account" && method === "DELETE") {
      await window.memoirLocal.clearAll();
      return { ok: true };
    }

    console.warn("[local-api] unhandled", method, pathname);
    return {};
  }

  function buildCategoryList(data) {
    const counts = {};
    for (const n of data.notes) {
      if (!n.category) continue;
      counts[n.category] = (counts[n.category] || 0) + 1;
    }
    return Object.keys(counts)
      .sort()
      .map((name) => ({ name, count: counts[name] }));
  }

  // ─────────────────────────────────────────────────────────────────────
  // fetch() interceptor
  // ─────────────────────────────────────────────────────────────────────

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    if (!url || !url.startsWith("/api/")) {
      return originalFetch(input, init);
    }
    const u = new URL(url, location.origin);
    const method = (init.method || "GET").toUpperCase();
    let body = {};
    if (init.body) {
      try {
        body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      } catch {
        body = {};
      }
    }
    try {
      const result = await handleApiRequest(u.pathname, method, body);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      console.error("[local-api] error handling", u.pathname, e);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // Settings modal wiring — builds hint content as DOM nodes (no innerHTML)
  // ─────────────────────────────────────────────────────────────────────

  function renderHintParts(container, parts) {
    // Clear safely
    while (container.firstChild) container.removeChild(container.firstChild);
    for (const part of parts) {
      if (part.text) {
        container.appendChild(document.createTextNode(part.text));
      } else if (part.link) {
        const a = document.createElement("a");
        a.href = part.link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = part.text;
        container.appendChild(a);
      } else if (part.code) {
        const c = document.createElement("code");
        c.textContent = part.code;
        container.appendChild(c);
      }
    }
  }

  function wireSettingsModal() {
    const overlay = document.getElementById("memoir-settings-overlay");
    const openBtn = document.getElementById("memoir-settings-open");
    const closeBtn = document.getElementById("memoir-settings-close");
    const cancelBtn = document.getElementById("memoir-settings-cancel");
    const saveBtn = document.getElementById("memoir-settings-save");
    const exportBtn = document.getElementById("memoir-export-data");
    const providerSelect = document.getElementById("memoir-provider");
    const modelSelect = document.getElementById("memoir-model");
    const keyInput = document.getElementById("memoir-api-key");
    const keyGroup = document.getElementById("memoir-key-group");
    const ollamaGroup = document.getElementById("memoir-ollama-group");
    const ollamaUrlInput = document.getElementById("memoir-ollama-url");
    const providerHint = document.getElementById("memoir-provider-hint");
    const statusEl = document.getElementById("memoir-settings-status");
    if (!overlay || !providerSelect) return;

    function refreshModelList(providerId) {
      const p = PROVIDERS[providerId];
      // Clear & rebuild options via DOM methods
      while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);
      for (const m of p.models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      }
      renderHintParts(providerHint, p.hintParts);
      keyGroup.style.display = p.needsKey ? "" : "none";
      ollamaGroup.style.display = providerId === "ollama" ? "" : "none";
    }

    async function openModal() {
      debugLog("openModal: entry");
      // Show the modal IMMEDIATELY with defaults so the user gets instant feedback.
      // The .overlay CSS class uses opacity + pointer-events (not display) so we
      // add the .open class — same pattern as the rest of the app's modals.
      providerSelect.value = "gemini";
      refreshModelList("gemini");
      modelSelect.value = PROVIDERS.gemini.defaultModel;
      keyInput.value = "";
      ollamaUrlInput.value = "http://localhost:11434";
      statusEl.textContent = "";
      overlay.classList.add("open");
      document.getElementById("profile-dropdown")?.classList.remove("open");
      debugLog("openModal: overlay shown");
      try {
        const s = await getSettings();
        debugLog("openModal: got settings " + JSON.stringify(s).slice(0, 80));
        providerSelect.value = s.provider || "gemini";
        refreshModelList(providerSelect.value);
        modelSelect.value = s.model || PROVIDERS[providerSelect.value].defaultModel;
        keyInput.value = s.api_key || "";
        ollamaUrlInput.value = s.ollama_url || "http://localhost:11434";
      } catch (e) {
        debugLog("openModal: getSettings failed — " + (e && e.message));
        statusEl.textContent = "(using default settings — couldn't load saved ones)";
      }
    }

    function closeModal() {
      overlay.classList.remove("open");
    }

    providerSelect.addEventListener("change", () => {
      const id = providerSelect.value;
      refreshModelList(id);
      modelSelect.value = PROVIDERS[id].defaultModel;
    });

    saveBtn.addEventListener("click", async () => {
      await updateSettings({
        provider: providerSelect.value,
        model: modelSelect.value,
        api_key: keyInput.value.trim(),
        ollama_url: ollamaUrlInput.value.trim() || "http://localhost:11434",
      });
      statusEl.textContent = "✓ Saved";
      setTimeout(closeModal, 600);
    });

    exportBtn.addEventListener("click", async () => {
      const json = await window.memoirLocal.exportData();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `memoir-export-${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    openBtn?.addEventListener("click", (e) => {
      debugLog("openBtn: click received");
      e.preventDefault();
      e.stopPropagation();
      openModal().catch((err) => debugLog("openModal threw: " + (err && err.message)));
    });
    debugLog("wireSettingsModal: handlers attached, openBtn=" + !!openBtn);
    closeBtn?.addEventListener("click", closeModal);
    cancelBtn?.addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("open")) closeModal();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireSettingsModal);
  } else {
    wireSettingsModal();
  }

  console.log(
    `[local-api] ready — ${IS_TAURI ? "Tauri desktop" : "browser"} mode, storage:`,
    IS_TAURI ? "disk" : "localStorage",
  );
})();
