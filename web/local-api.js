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
        { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (fast, free tier)" },
        { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite (fastest)" },
        { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
        { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro (more capable)" },
      ],
      defaultModel: "gemini-2.0-flash",
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

  function buildSystemPrompt() {
    const today = new Date().toISOString().split("T")[0];
    return `You are Memoir, a local-first notes assistant. The user will type something and you must classify their intent and extract structured data.

Intents:
- add_note:     a thought, idea, or piece of info to save
- add_task:     something to do, a todo, a reminder (may have a date/time)
- add_event:    a scheduled calendar event at a specific date/time
- add_bookmark: a URL to save
- search:       user asking about their own saved notes ("what did I write about X?")
- respond:      general question, greeting, or info request NOT about their notes

Rules:
- If the message contains a "?" or starts with what/how/why/where/when/should/can/is/are/tell me/help/explain → intent is "search" or "respond".
- Contains a date/time like "tomorrow 3pm", "Friday", "next week" describing something happening → "add_event". Todo → "add_task".
- Dates: ISO format YYYY-MM-DD. Today is ${today}.
- Categories for add_note: pick ONE from: work, personal, ideas, health, finance, learning, travel, projects, research, tech, entertainment, food, shopping, music, reading.
- Title: max 60 chars.
- Content: lightly polish (fix grammar/typos) but preserve the user's voice.

Output valid JSON matching this exact schema:
{
  "intent": "add_note" | "add_task" | "add_event" | "add_bookmark" | "search" | "respond",
  "category": string,
  "title": string,
  "content": string,
  "task_title": string, "task_description": string, "task_due_date": string, "task_due_time": string, "task_priority": number,
  "event_title": string, "event_date": string, "event_start_time": string, "event_end_time": string, "event_location": string, "event_description": string,
  "bookmark_url": string, "bookmark_title": string, "bookmark_description": string,
  "search_query": string,
  "response_text": string
}
Only include fields relevant to the intent. "intent" is required.`;
  }

  async function callGemini(userMessage, settings) {
    if (!settings.api_key) throw new Error("NO_KEY");
    const model = settings.model || PROVIDERS.gemini.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.api_key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      }),
    });
    if (!res.ok) throw new Error("Gemini: " + (await res.text()));
    const out = await res.json();
    const text = out.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini: empty response");
    return JSON.parse(text);
  }

  async function callOpenAI(userMessage, settings) {
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
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) throw new Error("OpenAI: " + (await res.text()));
    const out = await res.json();
    return JSON.parse(out.choices[0].message.content);
  }

  async function callAnthropic(userMessage, settings) {
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
        system: buildSystemPrompt() + "\n\nRespond with ONLY a JSON object. No prose. No code fences.",
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) throw new Error("Anthropic: " + (await res.text()));
    const out = await res.json();
    const text = out.content?.[0]?.text || "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned);
  }

  async function callOllama(userMessage, settings) {
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
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userMessage },
        ],
        options: { temperature: 0.3 },
      }),
    });
    if (!res.ok) throw new Error("Ollama: " + (await res.text()));
    const out = await res.json();
    return JSON.parse(out.message.content);
  }

  const PROVIDER_ADAPTERS = {
    gemini: callGemini,
    openai: callOpenAI,
    anthropic: callAnthropic,
    ollama: callOllama,
  };

  async function classifyIntent(userMessage, settings) {
    const adapter = PROVIDER_ADAPTERS[settings.provider] || PROVIDER_ADAPTERS.gemini;
    return await adapter(userMessage, settings);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Intent handlers
  // ─────────────────────────────────────────────────────────────────────

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

    let parsed;
    try {
      parsed = await classifyIntent(userMessage, settings);
    } catch (e) {
      if (e.message === "NO_KEY") {
        return { type: "chat_response", message: "No API key set. Open Settings in the profile menu." };
      }
      return { type: "chat_response", message: "AI call failed: " + e.message };
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
        return {
          type: "bookmark_saved",
          id: bm.id,
          bookmark_url: bm.url,
          bookmark_title: bm.title,
          bookmark_description: bm.content,
          bookmark_type: "website",
        };
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
      const s = await getSettings();
      providerSelect.value = s.provider || "gemini";
      refreshModelList(providerSelect.value);
      modelSelect.value = s.model || PROVIDERS[providerSelect.value].defaultModel;
      keyInput.value = s.api_key || "";
      ollamaUrlInput.value = s.ollama_url || "http://localhost:11434";
      statusEl.textContent = "";
      overlay.style.display = "";
      document.getElementById("profile-dropdown")?.classList.remove("open");
    }

    function closeModal() {
      overlay.style.display = "none";
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
      e.preventDefault();
      e.stopPropagation();
      openModal();
    });
    closeBtn?.addEventListener("click", closeModal);
    cancelBtn?.addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.style.display !== "none") closeModal();
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
