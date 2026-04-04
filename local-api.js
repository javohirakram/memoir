/**
 * Memoir — Local API shim
 *
 * Runs 100% in the browser. Intercepts all fetch("/api/*") calls the app makes
 * and serves them from localStorage + a direct OpenAI API call using the
 * user's own API key (stored locally, never sent to any server except OpenAI).
 *
 * Storage layout (single localStorage key, JSON-serialized):
 *   {
 *     notes:       [{ id, category, title, content, created, updated }],
 *     tasks:       [{ id, title, description, due_date, due_time, priority, project, labels, done, created }],
 *     events:      [{ id, title, date, end_date, start_time, end_time, all_day, location, description, color }],
 *     categories:  ["work", "personal", ...],
 *     chat:        [{ role, html }],
 *     preferences: { theme, onboarding_done, ... },
 *   }
 */
(function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────────────
  // Storage
  // ─────────────────────────────────────────────────────────────────────

  const STORAGE_KEY = "memoir_v1";
  const OPENAI_KEY_STORAGE = "memoir_openai_key";

  const DEFAULT_CATEGORIES = [
    "work", "personal", "ideas", "health", "finance", "learning",
    "travel", "projects", "research", "tech", "entertainment",
    "food", "shopping", "music", "reading",
  ];

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshData();
      const d = JSON.parse(raw);
      // Guarantee all keys exist (forward-compat for schema additions)
      d.notes ??= [];
      d.tasks ??= [];
      d.events ??= [];
      d.categories ??= [...DEFAULT_CATEGORIES];
      d.chat ??= [];
      d.preferences ??= {};
      return d;
    } catch (e) {
      console.warn("[local-api] corrupt storage, resetting", e);
      return freshData();
    }
  }

  function freshData() {
    return {
      notes: [],
      tasks: [],
      events: [],
      categories: [...DEFAULT_CATEGORIES],
      chat: [],
      preferences: { theme: "dark", onboarding_done: false },
    };
  }

  function saveData(d) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // ─────────────────────────────────────────────────────────────────────
  // OpenAI — direct call from the browser using the user's own key
  // ─────────────────────────────────────────────────────────────────────

  function getOpenAIKey() {
    return localStorage.getItem(OPENAI_KEY_STORAGE) || "";
  }

  function setOpenAIKey(key) {
    localStorage.setItem(OPENAI_KEY_STORAGE, key);
  }

  // Expose for settings UI
  window.memoirLocal = {
    getOpenAIKey,
    setOpenAIKey,
    exportData: () => JSON.stringify(loadData(), null, 2),
    importData: (json) => {
      const d = JSON.parse(json);
      saveData(d);
    },
    clearAll: () => localStorage.removeItem(STORAGE_KEY),
  };

  const SYSTEM_PROMPT = `You are Memoir, a local-first notes assistant. The user will type something and you must classify their intent and extract structured data.

Intents:
- add_note:     a thought, idea, or piece of info to save
- add_task:     something to do, a todo, a reminder (may have a date/time)
- add_event:    a scheduled calendar event at a specific date/time
- add_bookmark: a URL to save
- search:       user is asking about their own saved notes ("what did I write about X?")
- respond:      general question, greeting, or request for info that is NOT about their own notes

Rules:
- If the message contains a "?" or starts with what/how/why/where/when/should/can/is/are/tell me/help/explain → intent is "search" or "respond".
- If the message contains a date/time like "tomorrow 3pm", "Friday", "next week" and describes something happening → "add_event". If it's a todo → "add_task".
- Dates: always return ISO format YYYY-MM-DD. Today's date is ${new Date().toISOString().split("T")[0]}.
- Categories: pick from work, personal, ideas, health, finance, learning, travel, projects, research, tech, entertainment, food, shopping, music, reading.
- Keep title short (max 60 chars). Polish content lightly — fix grammar/typos only.`;

  const INTENT_SCHEMA = {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["add_note", "add_task", "add_event", "add_bookmark", "search", "respond"],
      },
      category: { type: "string" },
      title: { type: "string" },
      content: { type: "string" },
      summary: { type: "string" },
      task_title: { type: "string" },
      task_description: { type: "string" },
      task_due_date: { type: "string" },
      task_due_time: { type: "string" },
      task_priority: { type: "integer" },
      event_title: { type: "string" },
      event_date: { type: "string" },
      event_start_time: { type: "string" },
      event_end_time: { type: "string" },
      event_location: { type: "string" },
      event_description: { type: "string" },
      bookmark_url: { type: "string" },
      bookmark_title: { type: "string" },
      bookmark_description: { type: "string" },
      search_query: { type: "string" },
      response_text: { type: "string" },
    },
    required: ["intent"],
    additionalProperties: false,
  };

  async function classifyIntent(userMessage) {
    const key = getOpenAIKey();
    if (!key) {
      throw new Error("NO_KEY");
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "memoir_intent",
            strict: false,
            schema: INTENT_SCHEMA,
          },
        },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error("OpenAI error: " + err);
    }
    const out = await res.json();
    return JSON.parse(out.choices[0].message.content);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Intent handlers — turn parsed intent into a stored item + response
  // ─────────────────────────────────────────────────────────────────────

  async function handleMessage(userMessage) {
    let parsed;
    try {
      parsed = await classifyIntent(userMessage);
    } catch (e) {
      if (e.message === "NO_KEY") {
        return {
          type: "chat_response",
          message:
            "👋 Welcome to Memoir! To get started, add your OpenAI API key in Settings (gear icon in the top right). Your key is stored locally and only sent to OpenAI.",
        };
      }
      return {
        type: "chat_response",
        message: "Sorry, I hit an error calling the AI. Check your API key in Settings. (" + e.message + ")",
      };
    }

    const data = loadData();

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
        saveData(data);
        return {
          type: "note_saved",
          id: note.id,
          category: note.category,
          title: note.title,
          content: note.content,
          summary: parsed.summary || "",
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
        saveData(data);
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
        saveData(data);
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
        saveData(data);
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
          ? `Found ${results.length} note${results.length === 1 ? "" : "s"} about "${parsed.search_query || userMessage}":`
          : `I couldn't find any saved notes matching "${parsed.search_query || userMessage}".`;
        return { type: "search_results", message: msg, results };
      }

      case "respond":
      default:
        return {
          type: "chat_response",
          message: parsed.response_text || "Got it.",
        };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Route table — all /api/* endpoints the frontend calls
  // ─────────────────────────────────────────────────────────────────────

  const FAKE_USER = {
    email: "local@memoir.app",
    name: "You",
    picture: null,
    last_seen: localStorage.getItem("memoir_last_seen") || null,
  };

  async function handleApiRequest(pathname, method, body) {
    const data = loadData();

    // Auth/init endpoints — always return the fake local user
    if (pathname === "/api/init") {
      const lastSeen = FAKE_USER.last_seen;
      localStorage.setItem("memoir_last_seen", nowIso());
      return {
        config: { google_client_id: null, ai_enabled: true },
        user: { ...FAKE_USER, last_seen: lastSeen },
      };
    }
    if (pathname === "/api/auth/me") return { user: FAKE_USER };
    if (pathname.startsWith("/api/auth/")) return { user: FAKE_USER, token: "local" };

    // Dashboard — batch load
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

    // Core AI endpoint
    if (pathname === "/api/message" && method === "POST") {
      return await handleMessage(body.message || "");
    }

    // Notes
    if (pathname === "/api/categories") {
      return { categories: buildCategoryList(data) };
    }
    if (pathname === "/api/recent") {
      return { notes: data.notes.slice(0, 20) };
    }
    const noteMatch = pathname.match(/^\/api\/note\/([^/]+)$/);
    if (noteMatch) {
      const id = decodeURIComponent(noteMatch[1]);
      if (method === "GET") {
        const note = data.notes.find((n) => n.id === id);
        return note || {};
      }
      if (method === "DELETE") {
        data.notes = data.notes.filter((n) => n.id !== id);
        saveData(data);
        return { ok: true };
      }
      if (method === "PUT") {
        const i = data.notes.findIndex((n) => n.id === id);
        if (i >= 0) {
          data.notes[i] = { ...data.notes[i], ...body, updated: nowIso() };
          saveData(data);
        }
        return { ok: true };
      }
    }
    const notesByCatMatch = pathname.match(/^\/api\/notes\/(.+)$/);
    if (notesByCatMatch) {
      const cat = decodeURIComponent(notesByCatMatch[1]);
      return { notes: data.notes.filter((n) => n.category === cat) };
    }

    // Tasks
    if (pathname === "/api/tasks" && method === "GET") {
      return { tasks: data.tasks };
    }
    if (pathname === "/api/tasks" && method === "POST") {
      const task = { id: uuid(), done: false, created: nowIso(), ...body };
      data.tasks.unshift(task);
      saveData(data);
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
          saveData(data);
        }
        return { ok: true };
      }
      if (method === "DELETE") {
        data.tasks = data.tasks.filter((t) => t.id !== id);
        saveData(data);
        return { ok: true };
      }
    }

    // Events
    if (pathname === "/api/events" && method === "GET") {
      return { events: data.events };
    }
    if (pathname === "/api/events" && method === "POST") {
      const ev = { id: uuid(), ...body };
      data.events.unshift(ev);
      saveData(data);
      return ev;
    }

    // Preferences
    if (pathname === "/api/preferences") {
      if (method === "GET") return { preferences: data.preferences };
      if (method === "PUT") {
        data.preferences = { ...data.preferences, ...body };
        saveData(data);
        return { ok: true };
      }
    }

    // Chat history
    if (pathname === "/api/chat/history") {
      if (method === "GET") return { messages: data.chat };
      if (method === "PUT") {
        data.chat = body.messages || [];
        saveData(data);
        return { ok: true };
      }
      if (method === "DELETE") {
        data.chat = [];
        saveData(data);
        return { ok: true };
      }
    }

    // Subscription / account — stub all to local/unlimited
    if (pathname === "/api/subscription") return { plan: "local", status: "active" };
    if (pathname === "/api/undo-status") return { can_undo: false, can_redo: false };
    if (pathname === "/api/undo" || pathname === "/api/redo") return { ok: true };
    if (pathname === "/api/health") return { status: "ok" };
    if (pathname === "/api/config") return { ai_enabled: true };
    if (pathname === "/api/feedback") return { ok: true };

    if (pathname === "/api/export") {
      return data;
    }
    if (pathname === "/api/account" && method === "DELETE") {
      localStorage.removeItem(STORAGE_KEY);
      return { ok: true };
    }

    // Unknown endpoint — return empty success so the UI doesn't crash
    console.warn("[local-api] unhandled", method, pathname);
    return {};
  }

  function buildCategoryList(data) {
    const counts = {};
    for (const n of data.notes) {
      counts[n.category] = (counts[n.category] || 0) + 1;
    }
    return data.categories.map((name) => ({ name, count: counts[name] || 0 }));
  }

  // ─────────────────────────────────────────────────────────────────────
  // fetch() interceptor
  // ─────────────────────────────────────────────────────────────────────

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    if (!url || !url.startsWith("/api/")) {
      return originalFetch(input, init);
    }

    // Parse URL + body
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

  console.log("[local-api] ready — running 100% in your browser");
})();
