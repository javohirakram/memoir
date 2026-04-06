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

  function buildSystemPrompt(contextData) {
    const today = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];

    // Conversation context — what was just created/touched, and recent items
    let contextBlock = "";
    if (contextData) {
      const lines = [];
      if (contextData.lastTouched) {
        const lt = contextData.lastTouched;
        lines.push(
          `LAST TOUCHED (the user's most recent action — if they say "it", "that", "change X", they probably mean this):\n` +
          `  type: ${lt.type}\n` +
          `  id: ${lt.id}\n` +
          `  title: ${lt.title}\n` +
          (lt.due_date ? `  due_date: ${lt.due_date}\n` : "") +
          (lt.due_time ? `  due_time: ${lt.due_time}\n` : "") +
          (lt.date ? `  date: ${lt.date}\n` : "") +
          (lt.start_time ? `  start_time: ${lt.start_time}\n` : "")
        );
      }
      if (contextData.recentTasks?.length) {
        lines.push(
          `RECENT TASKS (most recent first):\n` +
          contextData.recentTasks
            .map((t) => `  [${t.id}] "${t.title}" due=${t.due_date || "none"} ${t.due_time || ""} ${t.done ? "(done)" : ""}`)
            .join("\n")
        );
      }
      if (contextData.recentEvents?.length) {
        lines.push(
          `RECENT EVENTS:\n` +
          contextData.recentEvents
            .map((e) => `  [${e.id}] "${e.title}" on ${e.date} ${e.start_time || ""}`)
            .join("\n")
        );
      }
      if (lines.length) contextBlock = "\n\n=== CONVERSATION CONTEXT ===\n" + lines.join("\n\n");
    }

    return `You are Memoir, a local-first notes assistant. The user will type something and you must classify their intent and extract structured data.

Intents:
- add_task:     the user is telling you something THEY NEED TO DO. This is the
                most common intent. Any imperative verb at the start of the
                message ("post", "send", "call", "write", "build", "email",
                "reply", "buy", "pay", "schedule", "book", "fix", "finish",
                "review", "remind me to X", "todo: X", "X by Friday") is a
                task. Does NOT require a date/time — "post on X about the
                new release" is a task even with no date.
- update_task:  the user wants to change a task they already created. Signals:
                "change X to Y", "move that to Friday", "push it back", "reschedule",
                "rename it", "mark done", "cancel it", "actually, 6pm instead",
                "wait, make it tuesday". Use the LAST TOUCHED context to resolve
                which task — put its id in target_id. You can change any field
                (title, due_date, due_time, priority, done).
- update_event: same as update_task but for calendar events. Use when user
                wants to modify a date, time, location, or title of a recent event.
- update_note:  same for notes (change title, content, or category).
- delete_task:  "delete that task", "remove it", "nevermind", "cancel that"
- delete_event: same for events
- delete_note:  same for notes
- add_event:    a scheduled calendar event at a SPECIFIC date AND time. Use for:
                meetings ("meeting with Sarah tomorrow 3pm"), appointments
                ("haircut at 3pm saturday", "dentist friday 10am", "doctor
                appointment wednesday"), social events ("dinner with Alex 7pm"),
                classes ("yoga class wednesday 6pm"), flights, and any event
                with another person. Solo activities WITH a specific time that
                are recurring or at a location (gym, yoga, haircut) are also
                events. Only prefer add_task over add_event when the message
                describes a deadline or todo, not a scheduled appointment.
- add_note:     a thought, idea, observation, or piece of info the user wants
                to remember. NOT an action. "idea — build a reddit scraper",
                "react 19 uses a new compiler", "the market closed green".
                When in doubt between add_note and add_task, ask: is the user
                telling me something they KNOW (note) or something they WILL
                DO (task)?
- add_bookmark: the message contains a URL the user wants to save
- search:       user asking about their OWN saved notes ("what did I write
                about X?", "show me my health notes")
- respond:      general question, greeting, or info request NOT about their
                notes ("what is rust?", "hello", "explain async/await")

Rules:
- Default to add_task for any imperative action the user intends to do.
  "post on X about Y" → add_task, NOT add_note.
  "write a blog post about launching Memoir" → add_task.
  "email John about the invoice" → add_task.
- If there is a LAST TOUCHED item in context and the user says "change X to Y",
  "make it Z", "actually...", "move that to...", "instead...", you MUST use
  update_task/update_event/update_note (NOT add_task) and put the LAST TOUCHED
  item's id in the target_id field. Do NOT create a new item.
- If there is NO LAST TOUCHED context but the user says "change it", "delete
  that", "update the time" — use "respond" and ask which item they mean.
  NEVER use update_*/delete_* without a target_id.
- Questions (contain "?" or start with what/how/why/where/when/should/can/is/
  are/tell me/help/explain) → search or respond, NEVER add_note/add_task.
- Dates: ISO format YYYY-MM-DD. Today is ${today}. Tomorrow is ${tomorrow}.
  "next Friday" = the Friday after this coming one.
- Times: 24-hour format "HH:MM". "6pm" → "18:00", "4 pm" → "16:00", "9am" → "09:00".
- Categories for add_note: pick ONE from: work, personal, ideas, health,
  finance, learning, travel, projects, research, tech, entertainment, food,
  shopping, music, reading.
- Title: max 60 chars.
- Content: lightly polish (fix grammar/typos) but preserve the user's voice.${contextBlock}

Output valid JSON matching this exact schema. Only include fields relevant to the intent. "intent" is required.
{
  "intent": "add_note" | "add_task" | "add_event" | "add_bookmark" | "update_task" | "update_event" | "update_note" | "delete_task" | "delete_event" | "delete_note" | "search" | "respond",
  "target_id": string,          // REQUIRED for update_*/delete_* — the id of the item to modify
  "category": string,
  "title": string,
  "content": string,
  "task_title": string, "task_description": string, "task_due_date": string, "task_due_time": string, "task_priority": number, "task_done": boolean,
  "event_title": string, "event_date": string, "event_start_time": string, "event_end_time": string, "event_location": string, "event_description": string,
  "bookmark_url": string, "bookmark_title": string, "bookmark_description": string,
  "search_query": string,
  "response_text": string
}`;
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

  async function callGemini(userMessage, settings, contextData) {
    if (!settings.api_key) throw new Error("NO_KEY");
    const model = settings.model || PROVIDERS.gemini.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.api_key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(contextData) }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      }),
    });
    if (!res.ok) throw classifyProviderError(res.status, await res.text(), "gemini");
    const out = await res.json();
    const text = out.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned an empty response. Try again.");
    return JSON.parse(text);
  }

  async function callOpenAI(userMessage, settings, contextData) {
    if (!settings.api_key) throw new Error("NO_KEY");
    const model = settings.model || PROVIDERS.openai.defaultModel;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.api_key,
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        temperature: 0.3,
        messages: [
          { role: "system", content: buildSystemPrompt(contextData) },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) throw classifyProviderError(res.status, await res.text(), "openai");
    const out = await res.json();
    return JSON.parse(out.choices[0].message.content);
  }

  async function callAnthropic(userMessage, settings, contextData) {
    if (!settings.api_key) throw new Error("NO_KEY");
    const model = settings.model || PROVIDERS.anthropic.defaultModel;
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
        system: buildSystemPrompt(contextData) + "\n\nRespond with ONLY a JSON object. No prose. No code fences.",
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) throw classifyProviderError(res.status, await res.text(), "anthropic");
    const out = await res.json();
    const text = out.content?.[0]?.text || "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned);
  }

  async function callOllama(userMessage, settings, contextData) {
    const baseUrl = (settings.ollama_url || "http://localhost:11434").replace(/\/$/, "");
    const model = settings.model || PROVIDERS.ollama.defaultModel;
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        format: "json",
        stream: false,
        messages: [
          { role: "system", content: buildSystemPrompt(contextData) },
          { role: "user", content: userMessage },
        ],
        options: { temperature: 0.3 },
      }),
    });
    if (!res.ok) throw classifyProviderError(res.status, await res.text(), "ollama");
    const out = await res.json();
    return JSON.parse(out.message.content);
  }

  const PROVIDER_ADAPTERS = {
    gemini: callGemini,
    openai: callOpenAI,
    anthropic: callAnthropic,
    ollama: callOllama,
  };

  async function classifyIntent(userMessage, settings, contextData) {
    const adapter = PROVIDER_ADAPTERS[settings.provider] || PROVIDER_ADAPTERS.gemini;
    return await adapter(userMessage, settings, contextData);
  }

  // In-memory context that follows the user through the conversation.
  // Not persisted — intentional, resets on app reload.
  let _lastTouched = null;
  function setLastTouched(type, item) {
    _lastTouched = {
      type,
      id: item.id,
      title: item.title || "",
      due_date: item.due_date,
      due_time: item.due_time,
      date: item.date,
      start_time: item.start_time,
      category: item.category,
    };
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

  async function handleMessage(userMessage) {
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

    // Build conversation context: last-touched item + a few recent tasks/events
    // so the model can resolve references like "it", "that", "change the time".
    const contextData = {
      lastTouched: _lastTouched,
      recentTasks: (data.tasks || []).slice(0, 5).map((t) => ({
        id: t.id, title: t.title, due_date: t.due_date, due_time: t.due_time, done: t.done,
      })),
      recentEvents: (data.events || []).slice(0, 5).map((e) => ({
        id: e.id, title: e.title, date: e.date, start_time: e.start_time,
      })),
    };

    let parsed;
    try {
      parsed = await classifyIntent(userMessage, settings, contextData);
    } catch (e) {
      if (e.message === "NO_KEY") {
        return { type: "chat_response", message: "No API key set. Open **Settings** in the profile menu." };
      }
      return { type: "chat_response", message: friendlyErrorMessage(e, settings) };
    }

    switch (parsed.intent) {
      case "add_note": {
        const note = {
          id: uuid(),
          category: parsed.category || "personal",
          title: parsed.title || userMessage.slice(0, 60),
          content: parsed.content || userMessage,
          created: nowIso(),
          updated: nowIso(),
        };
        data.notes.unshift(note);
        if (!data.categories.includes(note.category)) data.categories.push(note.category);
        await saveData(data);
        setLastTouched("note", note);
        return {
          type: "note_saved",
          id: note.id,
          category: note.category,
          title: note.title,
          content: note.content,
          summary: "",
        };
      }
      case "add_task": {
        const task = {
          id: uuid(),
          title: parsed.task_title || parsed.title || userMessage.slice(0, 60),
          description: parsed.task_description || "",
          due_date: parsed.task_due_date || null,
          due_time: parsed.task_due_time || null,
          priority: parsed.task_priority || 3,
          project: null,
          labels: [],
          done: false,
          created: nowIso(),
        };
        data.tasks.unshift(task);
        await saveData(data);
        setLastTouched("task", task);
        return {
          type: "task_created",
          id: task.id,
          title: task.title,
          description: task.description,
          due_date: task.due_date,
          due_time: task.due_time,
          priority: task.priority,
        };
      }
      case "add_event": {
        const ev = {
          id: uuid(),
          title: parsed.event_title || parsed.title || userMessage.slice(0, 60),
          date: parsed.event_date || new Date().toISOString().split("T")[0],
          end_date: null,
          start_time: parsed.event_start_time || null,
          end_time: parsed.event_end_time || null,
          all_day: !parsed.event_start_time,
          location: parsed.event_location || "",
          description: parsed.event_description || "",
          color: null,
        };
        data.events.unshift(ev);
        await saveData(data);
        setLastTouched("event", ev);
        return {
          type: "event_created",
          id: ev.id,
          title: ev.title,
          date: ev.date,
          start_time: ev.start_time,
          end_time: ev.end_time,
          location: ev.location,
        };
      }
      case "add_bookmark": {
        const bm = {
          id: uuid(),
          category: "reading",
          title: parsed.bookmark_title || parsed.bookmark_url || "Bookmark",
          content: parsed.bookmark_description || parsed.bookmark_url || "",
          url: parsed.bookmark_url || "",
          created: nowIso(),
          updated: nowIso(),
          is_bookmark: true,
        };
        data.notes.unshift(bm);
        if (!data.categories.includes("reading")) data.categories.push("reading");
        await saveData(data);
        setLastTouched("note", bm);
        return {
          type: "bookmark_saved",
          id: bm.id,
          bookmark_url: bm.url,
          bookmark_title: bm.title,
          bookmark_description: bm.content,
          bookmark_type: "website",
        };
      }

      case "update_task": {
        // Resolve target: prefer parsed.target_id, fallback to _lastTouched.
        const targetId =
          parsed.target_id ||
          (_lastTouched && _lastTouched.type === "task" ? _lastTouched.id : null);
        const idx = targetId ? data.tasks.findIndex((t) => t.id === targetId) : -1;
        if (idx < 0) {
          return {
            type: "chat_response",
            message: "I couldn't figure out which task you meant. Try mentioning it by name.",
          };
        }
        const before = { ...data.tasks[idx] };
        const patch = {};
        if (parsed.task_title !== undefined && parsed.task_title !== "") patch.title = parsed.task_title;
        if (parsed.task_description !== undefined && parsed.task_description !== "") patch.description = parsed.task_description;
        if (parsed.task_due_date !== undefined && parsed.task_due_date !== "") patch.due_date = parsed.task_due_date;
        if (parsed.task_due_time !== undefined && parsed.task_due_time !== "") patch.due_time = parsed.task_due_time;
        if (parsed.task_priority !== undefined && parsed.task_priority !== 0) patch.priority = parsed.task_priority;
        if (parsed.task_done !== undefined) patch.done = parsed.task_done;
        data.tasks[idx] = { ...before, ...patch };
        await saveData(data);
        setLastTouched("task", data.tasks[idx]);
        return {
          type: "task_created",
          id: data.tasks[idx].id,
          title: data.tasks[idx].title,
          description: data.tasks[idx].description,
          due_date: data.tasks[idx].due_date,
          due_time: data.tasks[idx].due_time,
          priority: data.tasks[idx].priority,
          _updated: true,
        };
      }

      case "update_event": {
        const targetId =
          parsed.target_id ||
          (_lastTouched && _lastTouched.type === "event" ? _lastTouched.id : null);
        const idx = targetId ? data.events.findIndex((e) => e.id === targetId) : -1;
        if (idx < 0) {
          return {
            type: "chat_response",
            message: "I couldn't figure out which event you meant. Try mentioning it by name.",
          };
        }
        const before = { ...data.events[idx] };
        const patch = {};
        if (parsed.event_title !== undefined && parsed.event_title !== "") patch.title = parsed.event_title;
        if (parsed.event_date !== undefined && parsed.event_date !== "") patch.date = parsed.event_date;
        if (parsed.event_start_time !== undefined && parsed.event_start_time !== "") {
          patch.start_time = parsed.event_start_time;
          patch.all_day = false;
        }
        if (parsed.event_end_time !== undefined && parsed.event_end_time !== "") patch.end_time = parsed.event_end_time;
        if (parsed.event_location !== undefined && parsed.event_location !== "") patch.location = parsed.event_location;
        if (parsed.event_description !== undefined && parsed.event_description !== "") patch.description = parsed.event_description;
        data.events[idx] = { ...before, ...patch };
        await saveData(data);
        setLastTouched("event", data.events[idx]);
        return {
          type: "event_created",
          id: data.events[idx].id,
          title: data.events[idx].title,
          date: data.events[idx].date,
          start_time: data.events[idx].start_time,
          end_time: data.events[idx].end_time,
          location: data.events[idx].location,
          _updated: true,
        };
      }

      case "update_note": {
        const targetId =
          parsed.target_id ||
          (_lastTouched && _lastTouched.type === "note" ? _lastTouched.id : null);
        const idx = targetId ? data.notes.findIndex((n) => n.id === targetId) : -1;
        if (idx < 0) {
          return {
            type: "chat_response",
            message: "I couldn't figure out which note you meant.",
          };
        }
        const before = { ...data.notes[idx] };
        const patch = { updated: nowIso() };
        if (parsed.title !== undefined && parsed.title !== "") patch.title = parsed.title;
        if (parsed.content !== undefined && parsed.content !== "") patch.content = parsed.content;
        if (parsed.category !== undefined && parsed.category !== "") patch.category = parsed.category;
        data.notes[idx] = { ...before, ...patch };
        await saveData(data);
        setLastTouched("note", data.notes[idx]);
        return {
          type: "note_saved",
          id: data.notes[idx].id,
          category: data.notes[idx].category,
          title: data.notes[idx].title,
          content: data.notes[idx].content,
          _updated: true,
        };
      }

      case "delete_task": {
        const targetId =
          parsed.target_id ||
          (_lastTouched && _lastTouched.type === "task" ? _lastTouched.id : null);
        const task = targetId ? data.tasks.find((t) => t.id === targetId) : null;
        if (!task) {
          return { type: "chat_response", message: "Couldn't figure out which task to delete." };
        }
        data.tasks = data.tasks.filter((t) => t.id !== targetId);
        await saveData(data);
        if (_lastTouched && _lastTouched.id === targetId) _lastTouched = null;
        return { type: "task_deleted", message: `Deleted task: **${task.title}**` };
      }

      case "delete_event": {
        const targetId =
          parsed.target_id ||
          (_lastTouched && _lastTouched.type === "event" ? _lastTouched.id : null);
        const ev = targetId ? data.events.find((e) => e.id === targetId) : null;
        if (!ev) {
          return { type: "chat_response", message: "Couldn't figure out which event to delete." };
        }
        data.events = data.events.filter((e) => e.id !== targetId);
        await saveData(data);
        if (_lastTouched && _lastTouched.id === targetId) _lastTouched = null;
        return { type: "event_deleted", message: `Deleted event: **${ev.title}**` };
      }

      case "delete_note": {
        const targetId =
          parsed.target_id ||
          (_lastTouched && _lastTouched.type === "note" ? _lastTouched.id : null);
        const note = targetId ? data.notes.find((n) => n.id === targetId) : null;
        if (!note) {
          return { type: "chat_response", message: "Couldn't figure out which note to delete." };
        }
        data.notes = data.notes.filter((n) => n.id !== targetId);
        await saveData(data);
        if (_lastTouched && _lastTouched.id === targetId) _lastTouched = null;
        return { type: "chat_response", message: `Deleted note: **${note.title}**` };
      }

      case "search": {
        const q = (parsed.search_query || userMessage).toLowerCase();
        const results = data.notes
          .filter(
            (n) =>
              (n.title || "").toLowerCase().includes(q) ||
              (n.content || "").toLowerCase().includes(q) ||
              (n.category || "").toLowerCase().includes(q),
          )
          .slice(0, 10);
        const msg = results.length
          ? `Found ${results.length} note${results.length === 1 ? "" : "s"} matching "${parsed.search_query || userMessage}":`
          : `No notes found matching "${parsed.search_query || userMessage}".`;
        return { type: "search_results", message: msg, results };
      }
      case "respond":
      default:
        return { type: "chat_response", message: parsed.response_text || "Got it." };
    }
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
