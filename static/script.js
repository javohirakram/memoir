/* ================================================================
   Memoir — Frontend (premium warm aesthetic)
   ================================================================ */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function getToken() { return localStorage.getItem("memoir-token"); }
function setToken(t) { localStorage.setItem("memoir-token", t); }
function clearToken() { localStorage.removeItem("memoir-token"); localStorage.removeItem("memoir-user"); }
function getStoredUser() { try { return JSON.parse(localStorage.getItem("memoir-user")); } catch { return null; } }
function setStoredUser(u) { try { localStorage.setItem("memoir-user", JSON.stringify(u)); } catch {} }

// PostHog helper (no-op if not initialized)
function phCapture(event, props = {}) {
    if (window.posthog && typeof posthog.capture === "function") posthog.capture(event, props);
}

async function apiFetch(url, opts = {}) {
    const token = getToken();
    if (!opts.headers) opts.headers = {};
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const res = await fetch(url, opts);
    if (res.status === 401) {
        clearToken();
        showLogin();
        throw new Error("Not authenticated");
    }
    if (res.status === 429) {
        try {
            const data = await res.clone().json();
            showToast(data.error || "Daily AI limit reached. Try again tomorrow.", 5000);
        } catch { showToast("Daily AI limit reached. Try again tomorrow.", 5000); }
        throw new Error("Rate limit exceeded");
    }
    return res;
}

// ── Chat persistence (synced to DB for cross-device access) ────
let currentUserEmail = null;
let _saveChatTimer = null;

function chatStorageKey() {
    return currentUserEmail ? `memoir_chat_${currentUserEmail}` : null;
}

function _collectChatMessages() {
    const msgs = [];
    document.getElementById("messages").querySelectorAll(".message").forEach(el => {
        msgs.push({ role: el.classList.contains("user") ? "user" : "assistant", html: el.innerHTML }); // safe: user's own app-generated HTML
    });
    return msgs;
}

function _renderChatMessages(msgs) {
    const messagesEl = document.getElementById("messages");
    messagesEl.innerHTML = "";
    msgs.forEach(m => {
        const div = document.createElement("div");
        div.className = `message ${m.role}`;
        div.innerHTML = DOMPurify.sanitize(m.html);
        messagesEl.appendChild(div);
        if (m.role === "assistant") {
            if (div.querySelector(".confirm-card")) bindConfirmCard(div);
            else if (div.querySelector(".bookmark-card")) bindBookmarkCard(div);
            else if (div.querySelector(".removal-card")) bindRemovalCard(div);
            else if (div.querySelector(".move-card")) bindMoveCard(div);
        }
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const clearBtn = document.getElementById("clear-chat-btn");
    if (clearBtn) clearBtn.style.display = msgs.length ? "" : "none";
}

function saveChat() {
    const msgs = _collectChatMessages();
    // Instant save to localStorage (cache for fast loads)
    const key = chatStorageKey();
    try {
        if (key && msgs.length) localStorage.setItem(key, JSON.stringify(msgs));
        else if (key) localStorage.removeItem(key);
    } catch {}
    const clearBtn = document.getElementById("clear-chat-btn");
    if (clearBtn) clearBtn.style.display = msgs.length ? "" : "none";
    // Debounced sync to server (cross-device)
    clearTimeout(_saveChatTimer);
    _saveChatTimer = setTimeout(async () => {
        if (!msgs.length) return;
        try {
            await apiFetch("/api/chat/history", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: msgs }),
            });
        } catch {}
    }, 1500);
}

async function restoreChat() {
    const messagesEl = document.getElementById("messages");
    // 1. Instant render from localStorage (fast)
    const key = chatStorageKey();
    let localMsgs = null;
    try { localMsgs = key ? JSON.parse(localStorage.getItem(key)) : null; } catch {}
    if (localMsgs && localMsgs.length) {
        _renderChatMessages(localMsgs);
    } else {
        showEmptyState();
    }
    // 2. Then fetch from API (may have newer data from another device)
    try {
        const r = await apiFetch("/api/chat/history");
        if (r.ok) {
            const data = await r.json();
            const apiMsgs = data.messages;
            if (apiMsgs && apiMsgs.length) {
                if (!localMsgs || apiMsgs.length !== localMsgs.length) {
                    _renderChatMessages(apiMsgs);
                    if (key) try { localStorage.setItem(key, JSON.stringify(apiMsgs)); } catch {}
                }
            }
        }
    } catch {}
}

async function clearChat() {
    const key = chatStorageKey();
    if (key) localStorage.removeItem(key);
    showEmptyState();
    const clearBtn = document.getElementById("clear-chat-btn");
    if (clearBtn) clearBtn.style.display = "none";
    try { await apiFetch("/api/chat/history", { method: "DELETE" }); } catch {}
}
// ────────────────────────────────────────────────────────────────

function showLogin() {
    document.getElementById("login-screen").style.display = "";
    document.getElementById("app-container").style.display = "none";
    // Close profile dropdown if open
    const dd = document.getElementById("profile-dropdown");
    if (dd) dd.classList.remove("open");
    // Clear all cached data from previous account
    calEvents = [];
    const calGrid = document.getElementById("cal-grid-wrapper");
    if (calGrid) calGrid.innerHTML = "";
    const taskList = document.getElementById("task-list");
    if (taskList) taskList.innerHTML = "";
    const msgs = document.getElementById("messages");
    if (msgs) msgs.innerHTML = "";
    currentUserEmail = null;
}

function showApp(user) {
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app-container").style.display = "";
    currentUserEmail = user?.email || null;
    // Set topbar avatar
    const avatar = document.getElementById("user-avatar");
    const fallback = document.querySelector(".user-fallback");
    if (user && user.picture) {
        avatar.src = user.picture;
        avatar.style.display = "";
        if (fallback) fallback.style.display = "none";
    } else {
        avatar.style.display = "none";
        if (fallback) fallback.style.display = "";
    }
    // Set profile dropdown info
    const profilePic = document.getElementById("profile-pic");
    const profileName = document.getElementById("profile-name");
    const profileEmail = document.getElementById("profile-email");
    if (user) {
        if (profilePic) profilePic.src = user.picture || "";
        if (profilePic) profilePic.style.display = user.picture ? "" : "none";
        if (profileName) profileName.textContent = user.name || "User";
        if (profileEmail) profileEmail.textContent = user.email || "";
    }
    // Analytics: identify user
    if (user && user.email) {
        if (window.posthog && typeof posthog.identify === "function") posthog.identify(user.email, { name: user.name });
        if (window.Sentry) try { Sentry.setUser({ email: user.email }); } catch {}
    }
    restoreChat();
    loadSidebar();
    loadTasks();
    renderCalendar();
    refreshUndoStatus();
    _loadPreferences();
    _loadSubscription();
}

async function _loadPreferences() {
    try {
        const r = await apiFetch("/api/preferences");
        if (!r.ok) return;
        const prefs = await r.json();
        // Sync theme from server (server wins if different from local)
        if (prefs.theme && prefs.theme !== document.documentElement.dataset.theme) {
            document.documentElement.dataset.theme = prefs.theme;
            localStorage.setItem("memoir-theme", prefs.theme);
        }
        // Show onboarding only if not done (server-synced)
        if (!prefs.onboarding_done) {
            setTimeout(() => openOverlay("onboarding-overlay"), 600);
        }
    } catch {}
}

async function _loadSubscription() {
    try {
        const r = await apiFetch("/api/subscription");
        if (!r.ok) return;
        const data = await r.json();
        const btn = document.getElementById("upgrade-btn");
        const txt = document.getElementById("upgrade-btn-text");
        if (data.plan === "pro" && btn && txt) {
            txt.textContent = "Pro Plan";
            btn.classList.add("active-plan");
        }
    } catch {}
}

function handleGoogleCredential(response) {
    if (!response || !response.credential) {
        alert("Google Sign-In did not return a credential. Please try again.");
        return;
    }
    fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: response.credential }),
    })
    .then(r => {
        if (!r.ok && r.headers.get("content-type")?.includes("application/json")) {
            return r.json();
        } else if (!r.ok) {
            throw new Error(`Server error (${r.status})`);
        }
        return r.json();
    })
    .then(data => {
        if (data.token) {
            setToken(data.token);
            setStoredUser(data.user);
            phCapture("login");
            showApp(data.user);
        } else {
            alert(data.error || "Login failed. Please try again.");
        }
    })
    .catch(err => alert("Login failed: " + err.message));
}

// Profile dropdown + Logout
document.addEventListener("DOMContentLoaded", () => {
    const profileBtn = document.getElementById("profile-btn");
    const dropdown = document.getElementById("profile-dropdown");
    const logoutBtn = document.getElementById("logout-btn");
    const clearChatBtn = document.getElementById("clear-chat-btn");
    if (clearChatBtn) clearChatBtn.onclick = () => clearChat();

    if (profileBtn && dropdown) {
        profileBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            dropdown.classList.toggle("open");
            profileBtn.classList.toggle("active");
        });
        document.addEventListener("click", (e) => {
            if (!dropdown.contains(e.target) && e.target !== profileBtn) {
                dropdown.classList.remove("open");
                profileBtn.classList.remove("active");
            }
        });
    }
    if (logoutBtn) logoutBtn.onclick = () => {
        clearToken();
        if (dropdown) dropdown.classList.remove("open");
        showLogin();
    };

    // Delete Account — open confirmation overlay
    const deleteAccountBtn = document.getElementById("delete-account-btn");
    const deleteConfirmInput = document.getElementById("delete-confirm-input");
    const deleteConfirmBtn = document.getElementById("delete-confirm");
    const deleteCancel = document.getElementById("delete-cancel");
    const deleteClose = document.getElementById("delete-modal-close");

    if (deleteAccountBtn) deleteAccountBtn.onclick = () => {
        if (dropdown) dropdown.classList.remove("open");
        if (profileBtn) profileBtn.classList.remove("active");
        if (deleteConfirmInput) deleteConfirmInput.value = "";
        if (deleteConfirmBtn) deleteConfirmBtn.disabled = true;
        openOverlay("delete-account-overlay");
    };
    if (deleteConfirmInput) deleteConfirmInput.oninput = () => {
        const match = deleteConfirmInput.value.trim().toLowerCase() === "delete my account";
        if (deleteConfirmBtn) deleteConfirmBtn.disabled = !match;
    };
    if (deleteConfirmBtn) deleteConfirmBtn.onclick = async () => {
        if (deleteConfirmBtn.disabled) return;
        deleteConfirmBtn.textContent = "Deleting...";
        deleteConfirmBtn.disabled = true;
        try {
            const r = await apiFetch("/api/account", { method: "DELETE" });
            if (r.ok) {
                clearToken();
                closeOverlay("delete-account-overlay");
                showToast("Account deleted.", 3000);
                setTimeout(() => showLogin(), 1000);
            }
        } catch {
            showToast("Failed to delete account. Please try again.", 3000);
            deleteConfirmBtn.textContent = "Delete Account";
            deleteConfirmBtn.disabled = false;
        }
    };
    if (deleteCancel) deleteCancel.onclick = () => closeOverlay("delete-account-overlay");
    if (deleteClose) deleteClose.onclick = () => closeOverlay("delete-account-overlay");

    // Upgrade to Pro
    const upgradeBtn = document.getElementById("upgrade-btn");
    if (upgradeBtn) upgradeBtn.onclick = async () => {
        if (dropdown) dropdown.classList.remove("open");
        if (profileBtn) profileBtn.classList.remove("active");
        try {
            const r = await apiFetch("/api/stripe/create-checkout", { method: "POST" });
            const data = await r.json();
            if (data.url) { window.location.href = data.url; return; }
            showToast(data.error || "Payments not available yet.", 3000);
        } catch { showToast("Could not start checkout.", 3000); }
    };

    // Export data
    const exportBtn = document.getElementById("export-btn");
    if (exportBtn) exportBtn.onclick = async () => {
        if (dropdown) dropdown.classList.remove("open");
        if (profileBtn) profileBtn.classList.remove("active");
        try {
            const r = await apiFetch("/api/export");
            const data = await r.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = "memoir-export.json";
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(url);
            showToast("Data exported successfully.", 3000);
            phCapture("export_data");
        } catch { showToast("Export failed. Please try again.", 3000); }
    };

    // Onboarding
    const onboardingDone = document.getElementById("onboarding-done");
    const onboardingOverlay = document.getElementById("onboarding-overlay");
    function _markOnboardingDone() {
        closeOverlay("onboarding-overlay");
        apiFetch("/api/preferences", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ onboarding_done: true }),
        }).catch(() => {});
    }
    if (onboardingDone) onboardingDone.onclick = _markOnboardingDone;
    if (onboardingOverlay) onboardingOverlay.onclick = e => {
        if (e.target.id === "onboarding-overlay") _markOnboardingDone();
    };

    // Feedback
    const feedbackBtn = document.getElementById("feedback-btn");
    if (feedbackBtn) feedbackBtn.onclick = () => {
        if (dropdown) dropdown.classList.remove("open");
        if (profileBtn) profileBtn.classList.remove("active");
        document.getElementById("feedback-message").value = "";
        openOverlay("feedback-overlay");
        document.getElementById("feedback-message").focus();
    };
    const feedbackCancel = document.getElementById("feedback-cancel");
    const feedbackModalClose = document.getElementById("feedback-modal-close");
    const feedbackOverlay = document.getElementById("feedback-overlay");
    const feedbackSend = document.getElementById("feedback-send");

    if (feedbackCancel) feedbackCancel.onclick = () => closeOverlay("feedback-overlay");
    if (feedbackModalClose) feedbackModalClose.onclick = () => closeOverlay("feedback-overlay");
    if (feedbackOverlay) feedbackOverlay.onclick = e => { if (e.target.id === "feedback-overlay") closeOverlay("feedback-overlay"); };
    if (feedbackSend) feedbackSend.onclick = async () => {
        const msg = document.getElementById("feedback-message").value.trim();
        if (!msg) return;
        feedbackSend.disabled = true;
        feedbackSend.textContent = "Sending...";
        try {
            const r = await apiFetch("/api/feedback", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: msg }),
            });
            if (r.ok) {
                closeOverlay("feedback-overlay");
                showToast("Thanks for your feedback!", 3000);
            } else {
                const data = await r.json().catch(() => ({}));
                showToast(data.error || "Failed to send. Please try again.", 3000);
            }
        } catch (err) {
            showToast("Failed to send feedback. Please try again.", 3000);
        }
        feedbackSend.disabled = false;
        feedbackSend.textContent = "Send Feedback";
    };
});

// Check auth on load
async function checkAuth() {
    const token = getToken();
    if (!token) { showLogin(); return; }
    try {
        const res = await fetch("/api/auth/me", {
            headers: { "Authorization": "Bearer " + token },
        });
        if (res.ok) {
            const data = await res.json();
            setStoredUser(data.user);
            showApp(data.user);
        } else if (res.status === 401) {
            // Only log out on explicit auth failure
            clearToken();
            showLogin();
        } else {
            // Server error / cold start — use cached user if available
            const stored = getStoredUser();
            if (stored) { showApp(stored); }
            else { showLogin(); }
        }
    } catch {
        // Network error — don't log out, use cached user
        const stored = getStoredUser();
        if (stored) { showApp(stored); return; }
        // No cached user, show login but keep token for retry
        showLogin();
    }
}

// Initialize Google Sign-In — render official button + try One Tap
let gsiReady = false;

function initGSI() {
    if (gsiReady) return true;
    if (typeof google !== "undefined" && google.accounts && window.GOOGLE_CLIENT_ID) {
        google.accounts.id.initialize({
            client_id: window.GOOGLE_CLIENT_ID,
            callback: handleGoogleCredential,
            use_fedcm_for_prompt: true,
        });
        // Render the official Google button immediately
        const gsiContainer = document.getElementById("google-signin-gsi");
        if (gsiContainer && !gsiContainer.hasChildNodes()) {
            google.accounts.id.renderButton(gsiContainer, {
                theme: "outline", size: "large", width: 300, text: "signin_with",
                shape: "rectangular", logo_alignment: "left",
            });
        }
        gsiReady = true;
        return true;
    }
    return false;
}

// Custom Google button click — fallback if GSI button hasn't rendered yet
document.addEventListener("DOMContentLoaded", () => {
    const customBtn = document.getElementById("google-signin-btn");
    if (customBtn) {
        customBtn.addEventListener("click", () => {
            if (initGSI()) return; // official button should now be rendered
            // GSI not ready yet — show loading state and retry
            const originalHTML = customBtn.innerHTML;
            customBtn.disabled = true;
            customBtn.querySelector("span").textContent = "Loading...";
            let attempts = 0;
            const wait = setInterval(() => {
                attempts++;
                if (initGSI()) {
                    clearInterval(wait);
                    customBtn.disabled = false;
                    customBtn.innerHTML = originalHTML;
                } else if (attempts >= 25) {
                    clearInterval(wait);
                    customBtn.disabled = false;
                    customBtn.innerHTML = originalHTML;
                    customBtn.querySelector("span").textContent = "Try again";
                }
            }, 200);
        });
    }
});

window.addEventListener("load", async () => {
    // Fetch Google Client ID from backend
    try {
        const cfgRes = await fetch("/api/config");
        const cfg = await cfgRes.json();
        window.GOOGLE_CLIENT_ID = cfg.google_client_id;
    } catch { /* will show login without button */ }

    // Initialize GSI library (retry until loaded)
    if (!initGSI()) {
        let attempts = 0;
        const retryInterval = setInterval(() => {
            attempts++;
            if (initGSI() || attempts >= 30) clearInterval(retryInterval);
        }, 200);
    }
    checkAuth();
});

marked.setOptions({
    breaks: true,
    gfm: true,
    renderer: (() => {
        const renderer = new marked.Renderer();
        const origLink = renderer.link.bind(renderer);
        renderer.link = (opts) => {
            const out = origLink(opts);
            // Add rel="noopener noreferrer" and target="_blank" to external links
            if (opts.href && /^https?:\/\//i.test(opts.href)) {
                return out.replace("<a ", '<a target="_blank" rel="noopener noreferrer" ');
            }
            return out;
        };
        return renderer;
    })(),
});

// Turndown: HTML -> Markdown conversion for WYSIWYG editor
const turndownService = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
});
turndownService.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: (content) => `~~${content}~~`,
});

const $ = (s) => document.getElementById(s);
const messagesEl = $("messages");
const form = $("form");
const inputEl = $("input");
const sendBtn = $("send-btn");

// Sidebar
const sidebar = $("sidebar");
const backdrop = $("sidebar-backdrop");
$("menu-btn").onclick = () => { sidebar.classList.add("open"); backdrop.classList.add("show"); };
$("sidebar-close").onclick = closeSidebar;
backdrop.onclick = closeSidebar;
function closeSidebar() { sidebar.classList.remove("open"); backdrop.classList.remove("show"); }

// Theme
const CATEGORIES = ["work","personal","ideas","health","finance","learning","travel","projects","research","tech","entertainment","food","shopping","music","reading"];
const CAT_LETTERS = { work:"W", personal:"P", ideas:"I", health:"H", finance:"F", learning:"L", travel:"T", projects:"J", research:"R", tech:"T", entertainment:"E", food:"Fo", shopping:"S", music:"M", reading:"Rd" };

function toggleTheme() {
    const html = document.documentElement;
    const next = html.dataset.theme === "dark" ? "light" : "dark";
    html.dataset.theme = next;
    localStorage.setItem("memoir-theme", next);
    // Sync to server
    apiFetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
    }).catch(() => {});
}
$("theme-toggle").onclick = toggleTheme;
$("theme-toggle-topbar").onclick = toggleTheme;

// Logo → home
document.querySelector(".topbar-title").onclick = () => switchApp("notes");

const saved = localStorage.getItem("memoir-theme");
if (saved) document.documentElement.dataset.theme = saved;

let currentNote = null;

/* ================================================================
   Sidebar: recent + categories
   ================================================================ */
function loadSidebar() { loadRecent(); loadCategories(); }

async function loadRecent() {
    try {
        const r = await apiFetch("/api/recent");
        const d = await r.json();
        const list = $("recent-list");
        if (!d.recent || !d.recent.length) {
            list.innerHTML = '<div class="sidebar-empty">No activity yet</div>';
            return;
        }
        list.innerHTML = d.recent.slice(0, 8).map(n => `
            <button class="recent-item" data-id="${ea(n.id)}">
                <span class="recent-dot ${esc(n.category)}"></span>
                <div class="recent-info">
                    <div class="recent-title">${esc(n.title)}</div>
                    <div class="recent-time">${timeAgo(n.created)}</div>
                </div>
            </button>`).join("");
        list.querySelectorAll(".recent-item").forEach(btn => {
            btn.onclick = async () => {
                closeSidebar();
                try {
                    const r2 = await apiFetch(`/api/note/${encodeURIComponent(btn.dataset.id)}`);
                    if (!r2.ok) return;
                    const note = await r2.json();
                    openNoteView(note);
                } catch {}
            };
        });
    } catch {}
}

async function loadCategories() {
    try {
        const r = await apiFetch("/api/categories");
        const d = await r.json();
        const list = $("category-list");
        if (!d.categories.length) { list.innerHTML = '<div class="sidebar-empty">No notebooks yet</div>'; return; }
        list.innerHTML = d.categories.map(c => `
            <button class="cat-item" data-cat="${esc(c.name)}">
                <span class="cat-icon ${esc(c.name)}">${CAT_LETTERS[c.name] || c.name[0].toUpperCase()}</span>
                <span class="cat-name">${cap(c.name)}</span>
                <span class="cat-count">${c.count}</span>
            </button>`).join("");
        list.querySelectorAll(".cat-item").forEach(b => b.onclick = () => openCategory(b.dataset.cat));
    } catch {}
}

// loadSidebar() is called by showApp() after auth

/* ================================================================
   Undo / Redo system (universal)
   ================================================================ */
async function refreshUndoStatus() {
    try {
        const r = await apiFetch("/api/undo-status");
        const d = await r.json();
        $("undo-btn").style.display = d.can_undo ? "" : "none";
        $("redo-btn").style.display = d.can_redo ? "" : "none";
    } catch {}
}

async function performUndo(actionId, cardEl) {
    try {
        const url = actionId
            ? `/api/undo/${encodeURIComponent(actionId)}`
            : "/api/undo";
        const r = await apiFetch(url, { method: "POST" });
        if (!r.ok) return;
        if (cardEl) {
            cardEl.classList.add("undone");
            setTimeout(() => {
                const msgEl = cardEl.closest(".message");
                if (msgEl) msgEl.remove();
            }, 450);
        }
        loadSidebar();
        refreshUndoStatus();
    } catch (err) {
        console.error("Undo failed:", err);
    }
}

async function performRedo() {
    try {
        const r = await apiFetch("/api/redo", { method: "POST" });
        if (!r.ok) return;
        loadSidebar();
        refreshUndoStatus();
    } catch (err) {
        console.error("Redo failed:", err);
    }
}

$("undo-btn").onclick = () => performUndo(null, null);
$("redo-btn").onclick = () => performRedo();

// Keyboard shortcuts: Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo
document.addEventListener("keydown", e => {
    // Skip if user is typing in an input/textarea/contenteditable
    const tag = document.activeElement?.tagName;
    const editable = document.activeElement?.isContentEditable;
    if (tag === "INPUT" || tag === "TEXTAREA" || editable) return;

    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        performUndo(null, null);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "Z" || e.key === "y")) {
        e.preventDefault();
        performRedo();
    }
});

/* ================================================================
   Category override dropdown
   ================================================================ */
function showRecatDropdown(triggerBtn, noteId, cardEl) {
    closeAllDropdowns();
    const dropdown = document.createElement("div");
    dropdown.className = "recat-dropdown";
    const currentCat = cardEl.querySelector(".cat-dot")?.classList[1] || "";
    dropdown.innerHTML = CATEGORIES.map(c =>
        `<button class="recat-option ${c === currentCat ? 'current' : ''}" data-cat="${c}">
            <span class="cat-icon ${c}" style="width:18px;height:18px;font-size:9px">${CAT_LETTERS[c] || c[0].toUpperCase()}</span>
            ${cap(c)}
        </button>`
    ).join("");
    triggerBtn.parentElement.style.position = "relative";
    triggerBtn.parentElement.appendChild(dropdown);

    dropdown.querySelectorAll(".recat-option:not(.current)").forEach(opt => {
        opt.onclick = async (e) => {
            e.stopPropagation();
            const newCat = opt.dataset.cat;
            try {
                await apiFetch(`/api/note/${encodeURIComponent(noteId)}/move`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ new_category: newCat }),
                });
                const dot = cardEl.querySelector(".cat-dot");
                if (dot) dot.className = "cat-dot " + newCat;
                const filed = cardEl.querySelector(".confirm-filed");
                if (filed) filed.innerHTML = `Filed to <strong>${esc(cap(newCat))}</strong>`;
                const accent = cardEl.querySelector(".confirm-card-accent");
                if (accent) {
                    cardEl.className = cardEl.className.replace(/\bcat-\w+/g, "") + " cat-" + newCat;
                }
                loadSidebar();
            } catch {}
            closeAllDropdowns();
        };
    });

    setTimeout(() => {
        document.addEventListener("click", closeAllDropdowns, { once: true });
    }, 10);
}

function closeAllDropdowns() {
    document.querySelectorAll(".recat-dropdown").forEach(d => d.remove());
}

/* ================================================================
   Category panel
   ================================================================ */
async function openCategory(name) {
    closeSidebar();
    $("cat-title").textContent = cap(name);
    $("cat-notes-list").innerHTML = '<div style="padding:20px;text-align:center"><div class="dots"><span></span><span></span><span></span></div></div>';
    openOverlay("cat-overlay");

    const r = await apiFetch(`/api/notes/${encodeURIComponent(name)}`);
    const d = await r.json();
    const list = $("cat-notes-list");

    if (!d.notes.length) { list.innerHTML = '<div class="sidebar-empty" style="padding:20px">Empty notebook</div>'; return; }
    list.innerHTML = d.notes.map(n => `
        <div class="cat-note" data-id="${ea(n.id || '')}" data-content="${ea(n.content)}" data-title="${ea(n.title)}" data-cat="${ea(n.category)}" data-date="${ea(n.created)}">
            <span class="cat-note-dot"></span>
            <div class="cat-note-info">
                <div class="cat-note-title">${esc(n.title)}</div>
                <div class="cat-note-date">${fmtDate(n.created)}</div>
            </div>
            <svg class="cat-note-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </div>`).join("");

    list.querySelectorAll(".cat-note").forEach(el => {
        el.onclick = async () => {
            closeOverlay("cat-overlay");
            try {
                const r2 = await apiFetch(`/api/note/${encodeURIComponent(el.dataset.id)}`);
                if (r2.ok) { openNoteView(await r2.json()); }
            } catch { openNoteView({ id: el.dataset.id, title: el.dataset.title, content: el.dataset.content, category: el.dataset.cat, created: el.dataset.date }); }
        };
    });
}

$("cat-close").onclick = () => closeOverlay("cat-overlay");
$("cat-overlay").onclick = e => { if (e.target.id === "cat-overlay") closeOverlay("cat-overlay"); };

$("cat-delete").onclick = () => {
    const name = $("cat-title").textContent;
    confirmAction(`Delete the "${name}" notebook and all its notes?`, async () => {
        await apiFetch(`/api/category/${encodeURIComponent(name.toLowerCase())}`, { method: "DELETE" });
        closeOverlay("cat-overlay");
        loadSidebar();
    });
};

/* ================================================================
   Note viewer modal
   ================================================================ */
let isFullscreen = false;

function openNoteView(note) {
    currentNote = note;
    $("modal-title").textContent = note.title;
    $("modal-body").innerHTML = DOMPurify.sanitize(marked.parse(note.content || ""));
    $("modal-badge").textContent = note.category;
    $("modal-badge").className = "pill " + (note.category || "");
    $("modal-date").textContent = fmtDate(note.created);
    $("modal-view").classList.remove("hidden");
    $("modal-edit-view").classList.add("hidden");

    // Original text
    const origSection = $("modal-original");
    if (note.original_text) {
        origSection.classList.remove("hidden");
        origSection.classList.remove("expanded");
        $("modal-original-text").textContent = note.original_text;
        $("modal-original-toggle").querySelector("span").textContent = "Show original";
    } else {
        origSection.classList.add("hidden");
    }

    // Reset fullscreen and AI prompt bar
    isFullscreen = false;
    $("modal").classList.remove("fullscreen");
    $("ai-prompt-bar").classList.add("hidden");

    openOverlay("modal-overlay");
}

function closeNoteModal() {
    isFullscreen = false;
    $("modal").classList.remove("fullscreen");
    closeOverlay("modal-overlay");
}

$("modal-close").onclick = closeNoteModal;
$("modal-overlay").onclick = e => { if (e.target.id === "modal-overlay") closeNoteModal(); };

/* Fullscreen toggle */
$("modal-fullscreen").onclick = () => {
    isFullscreen = !isFullscreen;
    $("modal").classList.toggle("fullscreen", isFullscreen);
};

/* Original text toggle in modal */
$("modal-original-toggle").onclick = () => {
    const wrapper = $("modal-original");
    wrapper.classList.toggle("expanded");
    const label = $("modal-original-toggle").querySelector("span");
    label.textContent = wrapper.classList.contains("expanded") ? "Hide original" : "Show original";
};

/* AI assist button — toggle prompt bar */
$("modal-ai").onclick = () => {
    const bar = $("ai-prompt-bar");
    bar.classList.toggle("hidden");
    if (!bar.classList.contains("hidden")) {
        $("ai-prompt-input").value = "";
        $("ai-prompt-input").focus();
    }
};

$("ai-prompt-close").onclick = () => {
    $("ai-prompt-bar").classList.add("hidden");
};

$("ai-prompt-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitAIPrompt(); }
});
$("ai-prompt-send").onclick = submitAIPrompt;

async function submitAIPrompt() {
    if (!currentNote?.id) return;
    const prompt = $("ai-prompt-input").value.trim();
    if (!prompt) return;

    // Save previous content for revert
    const previousContent = currentNote.content;

    // Show loading state
    const bar = $("ai-prompt-bar");
    bar.classList.add("hidden");
    const loader = document.createElement("div");
    loader.className = "ai-loading-bar";
    loader.innerHTML = `<div class="thinking-orb"></div><span class="thinking-text">Thinking...</span>`;
    $("modal-view").appendChild(loader);

    try {
        const r = await apiFetch(`/api/note/${encodeURIComponent(currentNote.id)}/ai`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt }),
        });
        const data = await r.json();
        loader.remove();

        if (data.ok && data.content) {
            currentNote.content = data.content;
            $("modal-body").innerHTML = DOMPurify.sanitize(marked.parse(data.content));
            loadSidebar();
            refreshUndoStatus();

            // Show revert button
            const existing = document.getElementById("ai-revert-bar");
            if (existing) existing.remove();
            const revertBar = document.createElement("div");
            revertBar.id = "ai-revert-bar";
            revertBar.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 22px;margin:0;background:var(--bg-elevated);border-bottom:1px solid var(--border);";
            revertBar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M12 2L9.5 8.5 2 12l7.5 3.5L12 22l2.5-6.5L22 12l-7.5-3.5z"/></svg><span style="font-size:0.78rem;color:var(--text-secondary);flex:1;">AI ${data.action === "append" ? "added content below" : "rewrote note"}</span><button class="btn ghost btn-sm" id="ai-revert-btn" style="font-size:0.78rem;padding:3px 10px;">Revert</button>`;
            $("modal-body").before(revertBar);

            document.getElementById("ai-revert-btn").onclick = async () => {
                revertBar.remove();
                currentNote.content = previousContent;
                $("modal-body").innerHTML = DOMPurify.sanitize(marked.parse(previousContent));
                // Restore in DB via undo API
                await apiFetch("/api/undo", { method: "POST" }).catch(() => {});
                loadSidebar();
                refreshUndoStatus();
            };
        }
    } catch (err) {
        loader.remove();
        console.error("AI transform failed:", err);
    }
}

$("modal-edit").onclick = () => {
    if (!currentNote) return;
    $("edit-title").value = currentNote.title;
    $("edit-content").innerHTML = DOMPurify.sanitize(marked.parse(currentNote.content || ""));
    $("modal-view").classList.add("hidden");
    $("modal-edit-view").classList.remove("hidden");
    $("edit-content").focus();
};

$("edit-cancel").onclick = () => {
    $("modal-view").classList.remove("hidden");
    $("modal-edit-view").classList.add("hidden");
};

$("edit-save").onclick = async () => {
    if (!currentNote?.id) return;
    const title = $("edit-title").value.trim();
    const htmlContent = $("edit-content").innerHTML;
    const content = turndownService.turndown(htmlContent);
    await apiFetch(`/api/note/${currentNote.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
    });
    currentNote.title = title;
    currentNote.content = content;
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = DOMPurify.sanitize(marked.parse(content));
    $("modal-view").classList.remove("hidden");
    $("modal-edit-view").classList.add("hidden");
    loadSidebar();
    refreshUndoStatus();
};

/* ================================================================
   WYSIWYG Toolbar handlers
   ================================================================ */
document.querySelectorAll(".toolbar-btn").forEach(btn => {
    btn.onmousedown = (e) => e.preventDefault(); // keep focus in contenteditable
    btn.onclick = (e) => {
        e.preventDefault();
        const cmd = btn.dataset.cmd;
        const val = btn.dataset.val || null;

        if (cmd === "heading") {
            document.execCommand("formatBlock", false, val);
        } else if (cmd === "code") {
            const sel = window.getSelection();
            if (sel.rangeCount > 0 && !sel.isCollapsed) {
                const range = sel.getRangeAt(0);
                const parent = sel.anchorNode.parentElement.closest("code");
                if (parent) {
                    const text = document.createTextNode(parent.textContent);
                    parent.replaceWith(text);
                } else {
                    const code = document.createElement("code");
                    range.surroundContents(code);
                }
            }
        } else if (cmd === "createLink") {
            const url = prompt("Enter URL:");
            if (url) document.execCommand("createLink", false, url);
        } else if (cmd === "formatBlock") {
            document.execCommand("formatBlock", false, val);
        } else {
            document.execCommand(cmd, false, val);
        }
        $("edit-content").focus();
    };
});

/* Keyboard shortcuts in editor */
$("edit-content").addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) {
        if (e.key === "b") { e.preventDefault(); document.execCommand("bold"); }
        else if (e.key === "i") { e.preventDefault(); document.execCommand("italic"); }
    }
});

$("modal-delete").onclick = () => {
    if (!currentNote?.id) return;
    confirmAction(`Delete "${currentNote.title}"?`, async () => {
        await apiFetch(`/api/note/${currentNote.id}`, { method: "DELETE" });
        closeNoteModal();
        loadSidebar();
    });
};

$("modal-move").onclick = () => {
    if (!currentNote?.id) return;
    const list = $("move-list");
    list.innerHTML = CATEGORIES.map(c => `
        <button class="move-item ${c === currentNote.category ? 'current' : ''}" data-cat="${c}">
            <span class="cat-icon ${c}">${CAT_LETTERS[c] || c[0].toUpperCase()}</span>
            ${cap(c)} ${c === currentNote.category ? '(current)' : ''}
        </button>`).join("");
    list.querySelectorAll(".move-item:not(.current)").forEach(btn => {
        btn.onclick = async () => {
            await apiFetch(`/api/note/${currentNote.id}/move`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ new_category: btn.dataset.cat }),
            });
            currentNote.category = btn.dataset.cat;
            $("modal-badge").textContent = btn.dataset.cat;
            $("modal-badge").className = "pill " + btn.dataset.cat;
            closeOverlay("move-overlay");
            loadSidebar();
        };
    });
    openOverlay("move-overlay");
};

$("move-close").onclick = () => closeOverlay("move-overlay");
$("move-overlay").onclick = e => { if (e.target.id === "move-overlay") closeOverlay("move-overlay"); };

/* ================================================================
   Confirm dialog
   ================================================================ */
let confirmCb = null;
function confirmAction(text, cb) {
    $("confirm-text").textContent = text;
    confirmCb = cb;
    openOverlay("confirm-overlay");
}
$("confirm-no").onclick = () => { confirmCb = null; closeOverlay("confirm-overlay"); };
$("confirm-yes").onclick = async () => { if (confirmCb) await confirmCb(); confirmCb = null; closeOverlay("confirm-overlay"); };
$("confirm-overlay").onclick = e => { if (e.target.id === "confirm-overlay") { confirmCb = null; closeOverlay("confirm-overlay"); } };

/* ================================================================
   Overlay helpers
   ================================================================ */
function openOverlay(id) { $(id).classList.add("open"); }
function closeOverlay(id) { $(id).classList.remove("open"); }

document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
        closeNoteModal();
        ["confirm-overlay","move-overlay","cat-overlay","task-overlay","event-overlay","feedback-overlay","onboarding-overlay"].forEach(closeOverlay);
        closeAllDropdowns();
    }
});

/* ================================================================
   Textarea auto-resize
   ================================================================ */
inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
});

/* ================================================================
   Voice input (Web Speech API)
   ================================================================ */
const micBtn = $("mic-btn");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;

    let isRecording = false;
    let prefixText = "";

    micBtn.onclick = () => {
        if (isRecording) {
            recognition.stop();
        } else {
            prefixText = inputEl.value;
            recognition.start();
        }
    };

    recognition.onstart = () => {
        isRecording = true;
        micBtn.classList.add("recording");
        inputEl.placeholder = "Listening — click mic to stop...";
    };

    recognition.onresult = (e) => {
        // Walk ALL results from the start each time — finals are stable,
        // only the last result can be interim.
        let transcript = "";
        for (let i = 0; i < e.results.length; i++) {
            transcript += e.results[i][0].transcript;
        }
        const sep = prefixText && !prefixText.endsWith(" ") && transcript ? " " : "";
        inputEl.value = prefixText + sep + transcript;
        inputEl.style.height = "auto";
        inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
    };

    recognition.onend = () => {
        isRecording = false;
        micBtn.classList.remove("recording");
        const placeholders = {
            notes: "Type anything — notes, tasks, events, or questions...",
            tasks: "Add a task... e.g. \"buy groceries by friday\" or \"remind me to call dentist tomorrow\"",
            calendar: "Schedule an event... e.g. \"meeting with Sarah tomorrow at 3pm\"",
        };
        inputEl.placeholder = placeholders[currentApp] || placeholders.notes;
        inputEl.focus();
    };

    recognition.onerror = (e) => {
        if (e.error !== "aborted") console.error("Speech recognition error:", e.error);
        recognition.stop();
    };

    // Stop recording before sending
    const origSend = sendMessage;
    sendMessage = function () {
        if (isRecording) recognition.stop();
        return origSend();
    };
} else {
    // Browser doesn't support speech recognition
    micBtn.style.display = "none";
}

/* ================================================================
   Thinking indicator (Claude-style)
   ================================================================ */
function appendThinking(text) {
    const div = document.createElement("div");
    div.className = "message assistant";
    div.innerHTML = `
        <div class="thinking-indicator">
            <div class="thinking-orb"></div>
            <span class="thinking-text">${esc(text || "Thinking")}</span>
        </div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
}

function guessThinkingText(text) {
    const t = text.toLowerCase();
    if (/bookmark|save.*link|save.*article|save.*video|save.*site|https?:\/\/|\.com\b|\.io\b|\.app\b|\.dev\b/.test(t)) return "Bookmarking";
    if (/\bmeeting\b|\bappointment\b|\bschedule\b|\bcalendar\b|\bevent\b|\bcall with\b|\blunch with\b|\bdinner\b/.test(t)) return "Scheduling";
    // Delete/remove checks before task creation to avoid "Creating task" on "delete the task"
    if (/add.*\bnote\b.*\bdelete\b|\bmove.*\bnote\b|\bnote\b.*delete.*\btask\b/.test(t)) return "Moving";
    if (/\bmove\b.*\b(from|to)\b|\btransfer\b/.test(t)) return "Moving";
    if (/(\bdelete\b|\bremove\b|\bcancel\b).*\b(task|event|note)\b|\b(task|event|note).*(\bdelete\b|\bremove\b|\bcancel\b)/.test(t)) return "Deleting";
    if (/\bremove\b|\bdelete\b|\btake off\b|\bdrop\b|\bscratch\b|\bcross off\b|\bget rid of\b/.test(t)) return "Removing";
    if (/\btask\b|\btodo\b|\bremind me\b|\bneed to\b|\bhave to\b|\bdeadline\b|\bgotta\b/.test(t)) return "Creating task";
    if (/\?|what|how|why|explain|tell me|can you|do you|is there|help/.test(t)) return "Thinking";
    if (/wanna|watch|read|listen|buy|add.*list|movie|book|song|grocery/.test(t)) return "Adding to list";
    if (/find|search|where|recall|remember|look up/.test(t)) return "Searching";
    return "Processing";
}

/* ================================================================
   Confirmation card — premium filing card
   ================================================================ */
function renderConfirmCard(data, originalText) {
    const cat = data.category || "personal";
    const title = data.title || "Note";
    const items = data.items || [];
    const actionId = data.action_id || "";
    const noteId = data.note_id || "";

    let itemsHtml = "";
    if (items.length > 0) {
        itemsHtml = `<div class="confirm-items">${items.map((item, i) =>
            `<div class="confirm-item" style="animation-delay:${0.15 + i * 0.08}s">
                <span class="confirm-item-check" style="animation-delay:${0.25 + i * 0.08}s"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></span>
                <span>${esc(item)}</span>
            </div>`
        ).join("")}</div>`;
    }

    const originalHtml = originalText ? `
            <div class="confirm-original">
                <button class="confirm-original-toggle">
                    <svg class="confirm-original-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                    <span>Show original</span>
                </button>
                <div class="confirm-original-text">${esc(originalText)}</div>
            </div>` : "";

    return `
        <div class="confirm-card cat-${esc(cat)}" data-action-id="${ea(actionId)}" data-note-id="${ea(noteId)}">
            <div class="confirm-card-accent"></div>
            <div class="confirm-card-header">
                <div class="confirm-card-meta">
                    <span class="cat-dot ${esc(cat)}"></span>
                    <span class="confirm-filed">Filed to <strong>${esc(cap(cat))}</strong></span>
                </div>
                <div class="confirm-card-actions">
                    <button class="icon-btn sm recat-btn" title="Move"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button>
                    <button class="icon-btn sm undo-card-btn" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
                </div>
            </div>
            <div class="confirm-card-title">${esc(title)}</div>
            ${itemsHtml}
            ${originalHtml}
            <div class="confirm-card-footer">
                <svg class="confirm-footer-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span>${esc(data.message)}</span>
            </div>
        </div>`;
}

function bindConfirmCard(msgEl) {
    const card = msgEl.querySelector(".confirm-card");
    if (!card) return;

    const recatBtn = card.querySelector(".recat-btn");
    const undoBtn = card.querySelector(".undo-card-btn");
    const noteId = card.dataset.noteId;
    const actionId = card.dataset.actionId;

    const originalToggle = card.querySelector(".confirm-original-toggle");
    if (originalToggle) {
        originalToggle.onclick = (e) => {
            e.stopPropagation();
            const wrapper = originalToggle.closest(".confirm-original");
            wrapper.classList.toggle("expanded");
            const label = originalToggle.querySelector("span");
            label.textContent = wrapper.classList.contains("expanded") ? "Hide original" : "Show original";
        };
    }

    if (recatBtn && noteId) {
        recatBtn.onclick = (e) => {
            e.stopPropagation();
            showRecatDropdown(recatBtn, noteId, card);
        };
    }

    if (undoBtn && actionId) {
        undoBtn.onclick = (e) => {
            e.stopPropagation();
            performUndo(actionId, card);
        };
    }

    // Click card body to open note
    if (noteId) {
        card.style.cursor = "pointer";
        card.onclick = async (e) => {
            if (e.target.closest("button")) return;
            try {
                const r = await apiFetch(`/api/note/${encodeURIComponent(noteId)}`);
                if (r.ok) openNoteView(await r.json());
            } catch {}
        };
    }

    refreshUndoStatus();
}

/* ================================================================
   Bookmark card
   ================================================================ */
const BTYPE_ICONS = {
    video: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21"/></svg>',
    article: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    startup: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    website: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    tool: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    other: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
};

function renderBookmarkCard(data, originalText) {
    const title = data.title || "Bookmark";
    const url = data.bookmark_url || "";
    const btype = data.bookmark_type || "website";
    const actionId = data.action_id || "";
    const noteId = data.note_id || "";
    const displayUrl = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const icon = BTYPE_ICONS[btype] || BTYPE_ICONS.other;

    const originalHtml = originalText ? `
            <div class="confirm-original">
                <button class="confirm-original-toggle">
                    <svg class="confirm-original-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                    <span>Show original</span>
                </button>
                <div class="confirm-original-text">${esc(originalText)}</div>
            </div>` : "";

    return `
        <div class="bookmark-card" data-action-id="${ea(actionId)}" data-note-id="${ea(noteId)}">
            <div class="bookmark-card-accent"></div>
            <div class="bookmark-card-header">
                <span class="bookmark-type-badge ${esc(btype)}">${icon} ${esc(cap(btype))}</span>
                <div class="bookmark-card-actions">
                    <button class="icon-btn sm undo-card-btn" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
                </div>
            </div>
            <div class="bookmark-card-title">${esc(title)}</div>
            <a class="bookmark-card-url" href="${ea(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                <span>${esc(displayUrl)}</span>
            </a>
            ${originalHtml}
            <div class="bookmark-card-footer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span>${esc(data.message)}</span>
            </div>
        </div>`;
}

function bindBookmarkCard(msgEl) {
    const card = msgEl.querySelector(".bookmark-card");
    if (!card) return;

    const undoBtn = card.querySelector(".undo-card-btn");
    const actionId = card.dataset.actionId;

    const originalToggle = card.querySelector(".confirm-original-toggle");
    if (originalToggle) {
        originalToggle.onclick = (e) => {
            e.stopPropagation();
            const wrapper = originalToggle.closest(".confirm-original");
            wrapper.classList.toggle("expanded");
            const label = originalToggle.querySelector("span");
            label.textContent = wrapper.classList.contains("expanded") ? "Hide original" : "Show original";
        };
    }

    if (undoBtn && actionId) {
        undoBtn.onclick = (e) => {
            e.stopPropagation();
            performUndo(actionId, card);
        };
    }

    refreshUndoStatus();
}

/* ================================================================
   Removal card — items removed from a list
   ================================================================ */
function renderRemovalCard(data, originalText) {
    const cat = data.category || "personal";
    const title = data.title || "List";
    const removed = data.removed_items || [];
    const actionId = data.action_id || "";
    const noteId = data.note_id || "";

    const itemsHtml = removed.length > 0
        ? `<div class="confirm-items">${removed.map((item, i) =>
            `<div class="confirm-item removed-item" style="animation-delay:${0.15 + i * 0.08}s">
                <span class="removed-item-x" style="animation-delay:${0.25 + i * 0.08}s"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
                <span class="removed-item-text">${esc(item)}</span>
            </div>`
        ).join("")}</div>`
        : "";

    const originalHtml = originalText ? `
            <div class="confirm-original">
                <button class="confirm-original-toggle">
                    <svg class="confirm-original-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                    <span>Show original</span>
                </button>
                <div class="confirm-original-text">${esc(originalText)}</div>
            </div>` : "";

    return `
        <div class="confirm-card removal-card cat-${esc(cat)}" data-action-id="${ea(actionId)}" data-note-id="${ea(noteId)}">
            <div class="confirm-card-accent"></div>
            <div class="confirm-card-header">
                <div class="confirm-card-meta">
                    <span class="cat-dot ${esc(cat)}"></span>
                    <span class="confirm-filed">Removed from <strong>${esc(title)}</strong></span>
                </div>
                <div class="confirm-card-actions">
                    <button class="icon-btn sm undo-card-btn" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
                </div>
            </div>
            <div class="confirm-card-title" style="opacity:.5;font-size:.85rem">Removed items</div>
            ${itemsHtml}
            ${originalHtml}
            <div class="confirm-card-footer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span>${esc(data.message)}</span>
            </div>
        </div>`;
}

function bindRemovalCard(msgEl) {
    const card = msgEl.querySelector(".confirm-card");
    if (!card) return;

    const undoBtn = card.querySelector(".undo-card-btn");
    const actionId = card.dataset.actionId;

    const originalToggle = card.querySelector(".confirm-original-toggle");
    if (originalToggle) {
        originalToggle.onclick = (e) => {
            e.stopPropagation();
            const wrapper = originalToggle.closest(".confirm-original");
            wrapper.classList.toggle("expanded");
            const label = originalToggle.querySelector("span");
            label.textContent = wrapper.classList.contains("expanded") ? "Hide original" : "Show original";
        };
    }

    if (undoBtn && actionId) {
        undoBtn.onclick = (e) => {
            e.stopPropagation();
            performUndo(actionId, card);
        };
    }

    refreshUndoStatus();
}

/* ================================================================
   Move card — items moved between notes/lists
   ================================================================ */
function renderMoveCard(data, originalText) {
    const cat = data.category || "personal";
    const destTitle = data.title || "destination";
    const srcTitle = data.source_title || "source";
    const movedItems = data.items || [];
    const actionId = data.action_id || "";
    const noteId = data.note_id || "";

    const itemsHtml = movedItems.length > 0
        ? `<div class="confirm-items">${movedItems.map((item, i) =>
            `<div class="confirm-item" style="animation-delay:${0.15 + i * 0.08}s">
                <span class="confirm-item-check" style="animation-delay:${0.25 + i * 0.08}s"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span>
                <span>${esc(item)}</span>
            </div>`
        ).join("")}</div>`
        : "";

    const originalHtml = originalText ? `
            <div class="confirm-original">
                <button class="confirm-original-toggle">
                    <svg class="confirm-original-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                    <span>Show original</span>
                </button>
                <div class="confirm-original-text">${esc(originalText)}</div>
            </div>` : "";

    return `
        <div class="confirm-card move-card cat-${esc(cat)}" data-action-id="${ea(actionId)}" data-note-id="${ea(noteId)}">
            <div class="confirm-card-accent"></div>
            <div class="confirm-card-header">
                <div class="confirm-card-meta">
                    <span class="cat-dot ${esc(cat)}"></span>
                    <span class="confirm-filed">Moved from <strong>${esc(srcTitle)}</strong> to <strong>${esc(destTitle)}</strong></span>
                </div>
                <div class="confirm-card-actions">
                    <button class="icon-btn sm undo-card-btn" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
                </div>
            </div>
            <div class="confirm-card-title">${esc(destTitle)}</div>
            ${itemsHtml}
            ${originalHtml}
            <div class="confirm-card-footer">
                <svg class="confirm-footer-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span>${esc(data.message)}</span>
            </div>
        </div>`;
}

function bindMoveCard(msgEl) {
    const card = msgEl.querySelector(".confirm-card");
    if (!card) return;

    const undoBtn = card.querySelector(".undo-card-btn");
    const actionId = card.dataset.actionId;

    const originalToggle = card.querySelector(".confirm-original-toggle");
    if (originalToggle) {
        originalToggle.onclick = (e) => {
            e.stopPropagation();
            const wrapper = originalToggle.closest(".confirm-original");
            wrapper.classList.toggle("expanded");
            const label = originalToggle.querySelector("span");
            label.textContent = wrapper.classList.contains("expanded") ? "Hide original" : "Show original";
        };
    }

    if (undoBtn && actionId) {
        undoBtn.onclick = (e) => {
            e.stopPropagation();
            performUndo(actionId, card);
        };
    }

    refreshUndoStatus();
}

/* ================================================================
   Form submit
   ================================================================ */
form.onsubmit = e => { e.preventDefault(); sendMessage(); };
inputEl.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

showEmptyState();

async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    phCapture("message_sent");
    const wasApp = currentApp;
    inputEl.value = "";
    inputEl.style.height = "auto";
    setLoading(true);

    // If on notes view, show in chat as before
    if (wasApp === "notes") {
        const empty = messagesEl.querySelector(".empty-state");
        if (empty) empty.remove();
        appendMsg("user", esc(text));
    }

    // Show thinking indicator (toast for non-notes, or chat for notes)
    let loader = null;
    if (wasApp === "notes") {
        loader = appendThinking(guessThinkingText(text));
    } else {
        loader = showToast(`<div class="thinking-indicator"><div class="thinking-orb"></div><span class="thinking-text">${esc(guessThinkingText(text))}</span></div>`, 0);
    }

    try {
        const r = await apiFetch("/api/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text }),
        });
        const data = await r.json();
        if (loader) { if (loader.remove) loader.remove(); else removeToast(loader); }

        if (data.type === "task_created") {
            phCapture("task_created");
            if (wasApp === "notes") {
                appendMsg("assistant", renderTaskCreatedCard(data));
            } else {
                showToast(renderTaskCreatedCard(data), 4000);
            }
            loadTasks();
            renderCalendar();
        } else if (data.type === "task_deleted" || data.type === "event_deleted") {
            const msg = `<div class="chat-response">${DOMPurify.sanitize(marked.parse(data.message))}</div>`;
            if (wasApp === "notes") {
                appendMsg("assistant", msg);
            } else {
                showToast(data.message, 3000);
            }
            loadTasks();
            renderCalendar();
        } else if (data.type === "event_created") {
            phCapture("event_created");
            if (wasApp === "notes") {
                appendMsg("assistant", renderEventCreatedCard(data));
            } else {
                showToast(renderEventCreatedCard(data), 4000);
            }
            renderCalendar();
            loadTasks();
        } else {
            // For all other types, show in the notes chat view
            if (wasApp !== "notes") {
                switchApp("notes");
                const empty = messagesEl.querySelector(".empty-state");
                if (empty) empty.remove();
                appendMsg("user", esc(text));
            }

            if (data.type === "chat_response") {
                appendMsg("assistant", `<div class="chat-response">${DOMPurify.sanitize(marked.parse(data.message))}</div>`);
            } else if (data.type === "bookmark_saved") {
                phCapture("bookmark_saved", { type: data.bookmark_type });
                const el = appendMsg("assistant", renderBookmarkCard(data, text));
                bindBookmarkCard(el);
                loadSidebar();
            } else if (data.type === "list_item_removed") {
                const el = appendMsg("assistant", renderRemovalCard(data, text));
                bindRemovalCard(el);
                loadSidebar();
            } else if (data.type === "item_moved") {
                const el = appendMsg("assistant", renderMoveCard(data, text));
                bindMoveCard(el);
                loadSidebar();
            } else if (data.type === "note_rewritten") {
                const el = appendMsg("assistant", renderConfirmCard(data, text));
                bindConfirmCard(el);
                loadSidebar();
            } else if (data.type === "note_saved" || data.type === "list_updated" || data.type === "note_updated") {
                phCapture("note_created", { category: data.category });
                const el = appendMsg("assistant", renderConfirmCard(data, text));
                bindConfirmCard(el);
                loadSidebar();
            } else if (data.type === "search_results") {
                let html = `<div class="chat-response">${DOMPurify.sanitize(marked.parse(data.message))}</div>`;
                if (data.results?.length) {
                    html += `<div class="sources-label">Sources</div><div class="results-grid">`;
                    for (const n of data.results) {
                        const preview = stripMd(n.content).substring(0, 150);
                        html += `
                            <div class="note-card" data-id="${ea(n.id)}" data-title="${ea(n.title)}" data-cat="${ea(n.category)}" data-content="${ea(n.content)}" data-date="${ea(n.created || '')}">
                                <div class="note-card-top">
                                    <span class="pill ${esc(n.category)}">${esc(n.category)}</span>
                                    <span class="note-card-title">${esc(n.title)}</span>
                                    <svg class="note-card-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                                </div>
                                <div class="note-card-preview">${esc(preview)}</div>
                            </div>`;
                    }
                    html += "</div>";
                }
                const el = appendMsg("assistant", html);
                el.querySelectorAll(".note-card").forEach(card => {
                    card.onclick = async () => {
                        try {
                            const r2 = await apiFetch(`/api/note/${encodeURIComponent(card.dataset.id)}`);
                            if (r2.ok) { openNoteView(await r2.json()); return; }
                        } catch {}
                        openNoteView({ id: card.dataset.id, title: card.dataset.title, content: card.dataset.content, category: card.dataset.cat, created: card.dataset.date });
                    };
                });
            }
        }
    } catch (err) {
        if (loader) { if (loader.remove) loader.remove(); else removeToast(loader); }
        if (wasApp === "notes") {
            appendMsg("assistant", '<span style="color:var(--text-muted)">Something went wrong. Please try again.</span>');
        } else {
            showToast('<span style="color:var(--danger)">Something went wrong. Please try again.</span>', 3000);
        }
        console.error(err);
    } finally {
        setLoading(false);
        inputEl.focus();
        refreshUndoStatus();
    }
}

/* ================================================================
   Empty state
   ================================================================ */
function showEmptyState() {
    messagesEl.innerHTML = `
    <div class="empty-state">
        <div class="empty-logo">
            <svg width="56" height="56" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="8" fill="url(#lg3)"/>
                <path d="M6 26 L9 7 L16 20 L21 7 L27 6 L23 14 L27 26 L23 26 L21 16 L25 11 L23 10 L16 17 L11 10 L10 26Z" fill="white" opacity="0.9"/>
                <defs><linearGradient id="lg3" x1="0" y1="0" x2="32" y2="32"><stop stop-color="#c48b5c"/><stop offset="1" stop-color="#8a5a32"/></linearGradient></defs>
            </svg>
        </div>
        <div class="empty-title">Welcome to Memoir</div>
        <div class="empty-desc">Your personal curation tool. Just type naturally — notes are polished, organized, and filed away for you.</div>
    </div>`;
}

/* ================================================================
   Helpers
   ================================================================ */
function appendMsg(role, html) {
    const div = document.createElement("div");
    div.className = `message ${role}`;
    div.innerHTML = html;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    saveChat();
    return div;
}

function setLoading(on) { inputEl.disabled = on; sendBtn.disabled = on; }

function localDateStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function ea(s) { return (s || "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function fmtDate(s) { if (!s) return ""; try { return new Date(s).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); } catch { return s; } }
function stripMd(s) { return (s || "").replace(/#{1,6}\s/g,"").replace(/\*\*/g,"").replace(/\*/g,"").replace(/`/g,"").replace(/- /g,"").replace(/\n+/g," ").trim(); }

function timeAgo(dateStr) {
    if (!dateStr) return "";
    try {
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        if (days < 7) return `${days}d ago`;
        return fmtDate(dateStr);
    } catch { return ""; }
}

/* ================================================================
   Toast notifications (for task/event confirmations in non-notes views)
   ================================================================ */
function showToast(html, duration) {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "toast-item";
    toast.innerHTML = html;
    container.appendChild(toast);
    // Animate in
    requestAnimationFrame(() => toast.classList.add("show"));
    if (duration > 0) {
        setTimeout(() => removeToast(toast), duration);
    }
    return toast;
}

function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.remove("show");
    toast.classList.add("hiding");
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 400);
}

/* ================================================================
   Task/Event created cards (for chat responses)
   ================================================================ */
function renderTaskCreatedCard(data) {
    return `
        <div class="confirm-card cat-work">
            <div class="confirm-card-accent" style="background:linear-gradient(to right,#6b94b4,#8ab5d4,#6b94b4)"></div>
            <div class="confirm-card-header">
                <div class="confirm-card-meta">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                    <span class="confirm-filed">Task created</span>
                </div>
            </div>
            <div class="confirm-card-title">${esc(data.title || '')}</div>
            <div class="confirm-card-footer">
                <svg class="confirm-footer-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span>${esc(data.message)}</span>
            </div>
        </div>`;
}

function renderEventCreatedCard(data) {
    return `
        <div class="confirm-card cat-personal">
            <div class="confirm-card-accent" style="background:linear-gradient(to right,#b07642,#d4a76a,#b07642)"></div>
            <div class="confirm-card-header">
                <div class="confirm-card-meta">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    <span class="confirm-filed">Event scheduled</span>
                </div>
            </div>
            <div class="confirm-card-title">${esc(data.title || '')}</div>
            <div class="confirm-card-footer">
                <svg class="confirm-footer-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span>${esc(data.message)}</span>
            </div>
        </div>`;
}

/* ================================================================
   Sub-app switching
   ================================================================ */
let currentApp = "notes";

document.querySelectorAll(".sidebar-tab").forEach(tab => {
    tab.onclick = () => switchApp(tab.dataset.app);
});

function switchApp(app) {
    currentApp = app;
    // Update tabs
    document.querySelectorAll(".sidebar-tab").forEach(t => t.classList.toggle("active", t.dataset.app === app));
    // Update sidebar navs
    document.querySelectorAll(".sidebar-nav").forEach(n => n.classList.add("hidden"));
    const navEl = $(`sidebar-nav-${app}`);
    if (navEl) navEl.classList.remove("hidden");
    // Update views
    document.querySelectorAll(".app-view").forEach(v => v.classList.remove("active"));
    const viewEl = $(`view-${app}`);
    if (viewEl) viewEl.classList.add("active");
    // Update placeholder
    const placeholders = {
        notes: "Type anything — notes, tasks, events, or questions...",
        tasks: "Add a task... e.g. \"buy groceries by friday\" or \"remind me to call dentist tomorrow\"",
        calendar: "Schedule an event... e.g. \"meeting with Sarah tomorrow at 3pm\"",
    };
    inputEl.placeholder = placeholders[app] || placeholders.notes;
    // Load data for the sub-app
    if (app === "tasks") loadTasks();
    if (app === "calendar") renderCalendar();
    closeSidebar();
    inputEl.focus();
}

/* ================================================================
   Tasks — Todoist-like task manager
   ================================================================ */
let currentTaskView = "inbox";
let editingTaskId = null;

// Task nav items
document.querySelectorAll(".task-nav-item").forEach(item => {
    item.onclick = () => {
        document.querySelectorAll(".task-nav-item").forEach(i => i.classList.remove("active"));
        item.classList.add("active");
        currentTaskView = item.dataset.view;
        $("tasks-view-title").textContent = cap(currentTaskView);
        loadTasks();
    };
});

const PRIORITY_COLORS = { 1: "#dc5050", 2: "#e8962e", 3: "#4a90d9", 4: "var(--text-muted)" };

// Show completed toggle
let showCompleted = false;
$("show-completed-btn").onclick = () => {
    showCompleted = !showCompleted;
    $("show-completed-btn").classList.toggle("active-toggle", showCompleted);
    loadTasks();
};

async function loadTasks() {
    let url = "/api/tasks";
    if (currentTaskView === "today") url += "?view=today";
    else if (currentTaskView === "upcoming") url += "?view=upcoming";
    else if (currentTaskView !== "inbox" && currentTaskView !== "today" && currentTaskView !== "upcoming") {
        url += `?project=${encodeURIComponent(currentTaskView)}`;
    } else {
        url += "?project=inbox";
    }

    try {
        const r = await apiFetch(url);
        const d = await r.json();
        let tasks = d.tasks || [];

        // Also load completed if toggled
        if (showCompleted) {
            const r2 = await apiFetch("/api/tasks?view=completed");
            const d2 = await r2.json();
            tasks = tasks.concat(d2.tasks || []);
        }

        // Also load overdue for today view
        let overdueTasks = [];
        if (currentTaskView === "today") {
            const r3 = await apiFetch("/api/tasks?view=overdue");
            const d3 = await r3.json();
            overdueTasks = d3.tasks || [];
        }

        renderTaskList(tasks, overdueTasks);
        loadTaskProjects();
    } catch (err) { console.error("Load tasks failed:", err); }
}

async function loadTaskProjects() {
    try {
        const r = await apiFetch("/api/tasks/projects");
        const d = await r.json();
        const list = $("task-projects-list");
        const projects = (d.projects || []).filter(p => p.name !== "inbox");
        if (!projects.length) {
            list.innerHTML = '<div class="sidebar-empty">No projects yet</div>';
            return;
        }
        list.innerHTML = projects.map(p => `
            <button class="cat-item ${currentTaskView === p.name ? 'active-project' : ''}" data-project="${esc(p.name)}">
                <span class="cat-icon projects">${p.name[0].toUpperCase()}</span>
                <span class="cat-name">${cap(p.name)}</span>
                <span class="cat-count">${p.count}</span>
            </button>`).join("");
        list.querySelectorAll(".cat-item").forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll(".task-nav-item").forEach(i => i.classList.remove("active"));
                currentTaskView = btn.dataset.project;
                $("tasks-view-title").textContent = cap(currentTaskView);
                loadTasks();
            };
        });

        // Update sidebar counts
        const allTasks = (await (await apiFetch("/api/tasks")).json()).tasks || [];
        const todayStr = localDateStr(new Date());
        const inbox = allTasks.filter(t => t.project === "inbox").length;
        const today = allTasks.filter(t => t.due_date === todayStr).length;
        const upcoming = allTasks.filter(t => t.due_date && t.due_date >= todayStr).length;
        $("inbox-count").textContent = inbox || "";
        $("today-count").textContent = today || "";
        $("upcoming-count").textContent = upcoming || "";
    } catch {}
}

function renderTaskList(tasks, overdueTasks = []) {
    const list = $("tasks-list");
    if (!tasks.length && !overdueTasks.length) {
        list.innerHTML = `<div class="tasks-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" opacity="0.4"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <div>No tasks here</div>
        </div>`;
        return;
    }

    let html = "";

    // Overdue section
    if (overdueTasks.length) {
        html += `<div class="task-section-label overdue-label">Overdue</div>`;
        overdueTasks.forEach(t => { html += renderTaskItem(t); });
        html += `<div class="task-section-divider"></div>`;
    }

    if (currentTaskView === "upcoming") {
        // Group by date
        const byDate = {};
        tasks.forEach(t => {
            const d = t.due_date || "No date";
            if (!byDate[d]) byDate[d] = [];
            byDate[d].push(t);
        });
        Object.keys(byDate).sort().forEach(date => {
            html += `<div class="task-section-label">${esc(formatTaskDate(date))}</div>`;
            byDate[date].forEach(t => { html += renderTaskItem(t); });
        });
    } else if (currentTaskView === "inbox" || currentTaskView === "today") {
        // Group by project
        const byProject = {};
        tasks.forEach(t => {
            const proj = t.project || "inbox";
            if (!byProject[proj]) byProject[proj] = [];
            byProject[proj].push(t);
        });
        const projKeys = Object.keys(byProject).sort((a, b) => a === "inbox" ? -1 : b === "inbox" ? 1 : a.localeCompare(b));
        const multipleProjects = projKeys.length > 1;
        projKeys.forEach(proj => {
            if (multipleProjects) {
                html += `<div class="task-section-label task-project-section">${esc(cap(proj))} <span class="task-section-count">${byProject[proj].length}</span></div>`;
            }
            byProject[proj].forEach(t => { html += renderTaskItem(t, multipleProjects); });
        });
    } else {
        // Project view — hide project tag since it's redundant
        tasks.forEach(t => { html += renderTaskItem(t, true); });
    }

    list.innerHTML = html;

    // Bind checkboxes and click handlers
    list.querySelectorAll(".task-item").forEach(el => {
        const tid = el.dataset.id;
        const cb = el.querySelector(".task-checkbox");
        cb.onclick = async (e) => {
            e.stopPropagation();
            const completed = !el.classList.contains("completed");
            el.classList.toggle("completed", completed);
            el.classList.add("completing");
            setTimeout(async () => {
                await apiFetch(`/api/tasks/${encodeURIComponent(tid)}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ completed }),
                });
                loadTasks();
            }, 400);
        };
        el.onclick = () => openTaskDetail(tid);
    });
}

function renderTaskItem(task, hideProject = false) {
    const pc = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS[4];
    const p = task.priority || 4;
    const dateLabel = task.due_date ? formatTaskDate(task.due_date) + (task.due_time ? " · " + formatTime12(task.due_time) : "") : "";
    const overdue = task.due_date && isOverdue(task.due_date);
    const todayDue = task.due_date && isToday(task.due_date);
    const dueDateHtml = dateLabel ? `<span class="task-due ${overdue ? 'overdue' : todayDue ? 'today' : ''}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        ${esc(dateLabel)}</span>` : "";
    const projectHtml = (!hideProject && task.project && task.project !== "inbox")
        ? `<span class="task-project-tag">#${esc(cap(task.project))}</span>` : "";
    const flagHtml = p < 4 ? `<span class="task-priority-flag p${p}" title="Priority ${p}"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/></svg></span>` : "";
    return `
        <div class="task-item ${task.completed ? 'completed' : ''} priority-${p}" data-id="${ea(task.id)}">
            <button class="task-checkbox" style="border-color:${pc}">
                ${task.completed ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${pc}" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
            </button>
            <div class="task-content">
                <span class="task-title">${esc(task.title)}</span>
                <div class="task-meta">${dueDateHtml}${projectHtml}${flagHtml}</div>
            </div>
        </div>`;
}

function isOverdue(dateStr) {
    return dateStr < localDateStr(new Date());
}

function isToday(dateStr) {
    return dateStr === localDateStr(new Date());
}

function formatTaskDate(dateStr) {
    if (!dateStr || dateStr === "No date") return dateStr;
    const today = new Date(); today.setHours(0,0,0,0);
    const d = new Date(dateStr + "T00:00:00"); d.setHours(0,0,0,0);
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    if (diff > 1 && diff < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Task detail modal
async function openTaskDetail(taskId) {
    editingTaskId = taskId;
    try {
        const r = await apiFetch("/api/tasks");
        const d = await r.json();
        let task = (d.tasks || []).find(t => t.id === taskId);
        if (!task) {
            const r2 = await apiFetch("/api/tasks?view=completed");
            const d2 = await r2.json();
            task = (d2.tasks || []).find(t => t.id === taskId);
        }
        if (!task) return;
        fillTaskModal(task);
        openOverlay("task-overlay");
    } catch (err) { console.error("Open task detail failed:", err); }
}

function fillTaskModal(task) {
    $("task-detail-title").value = task.title || "";
    $("task-detail-desc").value = task.description || "";
    $("task-detail-date").value = task.due_date || "";
    $("task-detail-time").value = task.due_time || "";
    $("task-detail-priority").value = String(task.priority || 4);
    $("task-detail-project").value = task.project || "inbox";
}

$("task-detail-save").onclick = async () => {
    if (!editingTaskId) return;
    await apiFetch(`/api/tasks/${encodeURIComponent(editingTaskId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title: $("task-detail-title").value.trim(),
            description: $("task-detail-desc").value.trim(),
            due_date: $("task-detail-date").value || null,
            due_time: $("task-detail-time").value || null,
            priority: parseInt($("task-detail-priority").value),
            project: $("task-detail-project").value.trim() || "inbox",
        }),
    });
    closeOverlay("task-overlay");
    loadTasks();
};

$("task-detail-cancel").onclick = () => closeOverlay("task-overlay");
$("task-modal-close").onclick = () => closeOverlay("task-overlay");
$("task-overlay").onclick = e => { if (e.target.id === "task-overlay") closeOverlay("task-overlay"); };

$("task-modal-delete").onclick = () => {
    if (!editingTaskId) return;
    confirmAction("Delete this task?", async () => {
        await apiFetch(`/api/tasks/${encodeURIComponent(editingTaskId)}`, { method: "DELETE" });
        closeOverlay("task-overlay");
        loadTasks();
    });
};

/* ================================================================
   Calendar — Google Calendar-like
   ================================================================ */
let calDate = new Date();
let calView = "month";
let calEvents = [];
let editingEventId = null;

// View switcher
document.querySelectorAll(".cal-view-btn").forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll(".cal-view-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        calView = btn.dataset.view;
        renderCalendar();
    };
});

$("cal-today-btn").onclick = () => { calDate = new Date(); renderCalendar(); };
$("cal-prev").onclick = () => {
    if (calView === "month") calDate.setMonth(calDate.getMonth() - 1);
    else if (calView === "week") calDate.setDate(calDate.getDate() - 7);
    else calDate.setDate(calDate.getDate() - 1);
    renderCalendar();
};
$("cal-next").onclick = () => {
    if (calView === "month") calDate.setMonth(calDate.getMonth() + 1);
    else if (calView === "week") calDate.setDate(calDate.getDate() + 7);
    else calDate.setDate(calDate.getDate() + 1);
    renderCalendar();
};

async function renderCalendar() {
    const month = `${calDate.getFullYear()}-${String(calDate.getMonth() + 1).padStart(2, '0')}`;
    if (calView === "day") {
        $("cal-title").textContent = calDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    } else if (calView === "week") {
        const ws = new Date(calDate); ws.setDate(ws.getDate() - ws.getDay());
        const we = new Date(ws); we.setDate(we.getDate() + 6);
        const sameMonth = ws.getMonth() === we.getMonth();
        $("cal-title").textContent = sameMonth
            ? ws.toLocaleDateString("en-US", { month: "long", year: "numeric" })
            : ws.toLocaleDateString("en-US", { month: "short" }) + " – " + we.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    } else {
        $("cal-title").textContent = calDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }

    // Load events
    try {
        // Load current month + adjacent months for week view
        const r = await apiFetch(`/api/events?month=${month}`);
        const d = await r.json();
        calEvents = d.events || [];

        // Also load tasks with due dates for calendar
        const tr = await apiFetch("/api/tasks");
        const td = await tr.json();
        const taskEvents = (td.tasks || []).filter(t => t.due_date).map(t => ({
            id: "task-" + t.id,
            title: t.title,
            date: t.due_date,
            start_time: t.due_time,
            end_time: null,
            all_day: !t.due_time,
            color: t.completed ? "grey" : (t.priority === 1 ? "red" : t.priority === 2 ? "orange" : t.priority === 3 ? "blue" : "teal"),
            is_task: true,
            completed: t.completed,
        }));
        calEvents = calEvents.concat(taskEvents);
    } catch {}

    if (calView === "month") renderMonthView();
    else if (calView === "week") renderWeekView();
    else renderDayView();

    // Render mini calendar
    renderMiniCalendar();
}

function renderMonthView() {
    const year = calDate.getFullYear();
    const month = calDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = localDateStr(new Date());

    let html = '<div class="cal-month-grid">';
    // Day headers
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(d => {
        html += `<div class="cal-day-header">${d}</div>`;
    });

    // Blank days
    for (let i = 0; i < firstDay; i++) {
        html += `<div class="cal-day-cell empty"></div>`;
    }

    // Days
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isToday = dateStr === todayStr;
        const dayEvents = calEvents.filter(e => e.date === dateStr);

        html += `<div class="cal-day-cell ${isToday ? 'today' : ''}" data-date="${dateStr}">`;
        html += `<div class="cal-day-num ${isToday ? 'today' : ''}">${day}</div>`;

        const maxShow = 3;
        dayEvents.slice(0, maxShow).forEach(ev => {
            const timeStr = ev.start_time ? formatTime12(ev.start_time) + " " : "";
            const taskClass = ev.is_task ? (ev.completed ? "task-chip completed" : "task-chip") : "";
            html += `<div class="cal-event-chip ${esc(ev.color || 'blue')} ${taskClass}" data-id="${ea(ev.id)}" title="${ea(ev.title)}">
                ${ev.is_task ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> ' : ''}${esc(timeStr)}${esc(ev.title)}
            </div>`;
        });
        if (dayEvents.length > maxShow) {
            html += `<div class="cal-more">+${dayEvents.length - maxShow} more</div>`;
        }
        html += `</div>`;
    }

    html += '</div>';
    $("cal-grid-wrapper").innerHTML = html;

    // Bind click on day cells to create events
    document.querySelectorAll(".cal-day-cell:not(.empty)").forEach(cell => {
        cell.onclick = (e) => {
            if (e.target.closest(".cal-event-chip")) return;
            openEventModal(cell.dataset.date);
        };
    });

    // Bind click on event chips
    document.querySelectorAll(".cal-event-chip").forEach(chip => {
        chip.onclick = (e) => {
            e.stopPropagation();
            const id = chip.dataset.id;
            if (id.startsWith("task-")) {
                openTaskDetail(id.replace("task-", ""));
            } else {
                openEventDetailModal(id);
            }
        };
    });
}

function renderWeekView() {
    const startOfWeek = new Date(calDate);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const todayStr = localDateStr(new Date());

    let html = '<div class="cal-week-grid">';
    // Header
    html += '<div class="cal-week-header"><div class="cal-week-gutter"></div>';
    for (let i = 0; i < 7; i++) {
        const d = new Date(startOfWeek);
        d.setDate(d.getDate() + i);
        const dateStr = localDateStr(d);
        const isToday = dateStr === todayStr;
        const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
        const dayNum = d.getDate();
        html += `<div class="cal-week-day-header ${isToday ? 'today' : ''}">
            <span class="cal-week-day-name">${dayName}</span>
            <span class="cal-week-day-num ${isToday ? 'today' : ''}">${dayNum}</span>
        </div>`;
    }
    html += '</div>';

    // All-day events row
    html += '<div class="cal-week-allday"><div class="cal-week-gutter">All day</div>';
    for (let i = 0; i < 7; i++) {
        const d = new Date(startOfWeek);
        d.setDate(d.getDate() + i);
        const dateStr = localDateStr(d);
        const allDayEvents = calEvents.filter(e => e.date === dateStr && e.all_day);
        html += `<div class="cal-week-allday-cell">`;
        allDayEvents.forEach(ev => {
            html += `<div class="cal-event-chip small ${esc(ev.color || 'blue')}" data-id="${ea(ev.id)}">${esc(ev.title)}</div>`;
        });
        html += `</div>`;
    }
    html += '</div>';

    // Time grid
    html += '<div class="cal-week-body">';
    for (let hour = 6; hour < 23; hour++) {
        html += `<div class="cal-week-row">`;
        html += `<div class="cal-week-gutter">${formatHour(hour)}</div>`;
        for (let i = 0; i < 7; i++) {
            const d = new Date(startOfWeek);
            d.setDate(d.getDate() + i);
            const dateStr = localDateStr(d);
            const hourEvents = calEvents.filter(e => {
                if (!e.start_time || e.all_day) return false;
                const sh = parseInt(e.start_time.split(":")[0]);
                return e.date === dateStr && sh === hour;
            });
            html += `<div class="cal-week-cell" data-date="${dateStr}" data-hour="${hour}">`;
            hourEvents.forEach(ev => {
                const duration = ev.end_time ? calcDuration(ev.start_time, ev.end_time) : 1;
                const topOffset = parseInt(ev.start_time.split(":")[1]) / 60 * 100;
                html += `<div class="cal-week-event ${esc(ev.color || 'blue')}" data-id="${ea(ev.id)}" style="top:${topOffset}%;height:${duration * 100}%">
                    <div class="cal-week-event-time">${formatTime12(ev.start_time)}</div>
                    <div class="cal-week-event-title">${esc(ev.title)}</div>
                </div>`;
            });
            html += `</div>`;
        }
        html += `</div>`;
    }
    html += '</div></div>';

    $("cal-grid-wrapper").innerHTML = html;

    // Bind clicks
    document.querySelectorAll(".cal-week-cell").forEach(cell => {
        cell.onclick = (e) => {
            if (e.target.closest(".cal-week-event")) return;
            openEventModal(cell.dataset.date, cell.dataset.hour + ":00");
        };
    });
    document.querySelectorAll(".cal-week-event, .cal-week-allday-cell .cal-event-chip").forEach(ev => {
        ev.onclick = (e) => {
            e.stopPropagation();
            const id = ev.dataset.id;
            if (id && id.startsWith("task-")) openTaskDetail(id.replace("task-", ""));
            else if (id) openEventDetailModal(id);
        };
    });

    // Current time red line
    const now = new Date();
    const todayStr2 = localDateStr(now);
    const weekStart = new Date(calDate);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekDates = Array.from({length: 7}, (_, i) => {
        const d = new Date(weekStart); d.setDate(d.getDate() + i); return localDateStr(d);
    });
    const todayColIdx = weekDates.indexOf(todayStr2);
    if (todayColIdx >= 0) {
        const nowH = now.getHours();
        const nowM = now.getMinutes();
        if (nowH >= 6 && nowH < 23) {
            const rowIdx = nowH - 6;
            const rows = document.querySelectorAll(".cal-week-row");
            if (rows[rowIdx]) {
                const cells = rows[rowIdx].querySelectorAll(".cal-week-cell");
                if (cells[todayColIdx]) {
                    const pct = (nowM / 60) * 100;
                    const line = document.createElement("div");
                    line.className = "cal-now-line";
                    line.style.cssText = `position:absolute;left:0;right:0;top:${pct}%;height:2px;background:#dc5050;z-index:10;pointer-events:none;`;
                    const dot = document.createElement("div");
                    dot.style.cssText = `position:absolute;left:-4px;top:-3px;width:8px;height:8px;border-radius:50%;background:#dc5050;`;
                    line.appendChild(dot);
                    cells[todayColIdx].style.position = "relative";
                    cells[todayColIdx].appendChild(line);
                }
            }
        }
    }

    // Auto-scroll to current time
    const body = document.querySelector(".cal-week-body");
    if (body) {
        const scrollHour = Math.max(0, now.getHours() - 2);
        const rows = body.querySelectorAll(".cal-week-row");
        if (rows[scrollHour - 6]) rows[scrollHour - 6].scrollIntoView({ block: "start", behavior: "smooth" });
        else body.scrollTop = (now.getHours() - 6 - 1) * 48;
    }
}

function renderDayView() {
    const dateStr = localDateStr(calDate);
    const todayStr = localDateStr(new Date());
    const isToday = dateStr === todayStr;

    let html = '<div class="cal-week-grid cal-day-view-grid">';

    // Header
    html += '<div class="cal-week-header"><div class="cal-week-gutter"></div>';
    html += `<div class="cal-week-day-header ${isToday ? 'today' : ''}">
        <span class="cal-week-day-name">${calDate.toLocaleDateString("en-US", { weekday: "short" })}</span>
        <span class="cal-week-day-num ${isToday ? 'today' : ''}">${calDate.getDate()}</span>
    </div>`;
    html += '</div>';

    // All-day events
    const allDayEvents = calEvents.filter(e => e.date === dateStr && e.all_day);
    html += '<div class="cal-week-allday"><div class="cal-week-gutter">All day</div>';
    html += '<div class="cal-week-allday-cell">';
    allDayEvents.forEach(ev => {
        html += `<div class="cal-event-chip small ${esc(ev.color || 'blue')}" data-id="${ea(ev.id)}">${esc(ev.title)}</div>`;
    });
    html += '</div></div>';

    // Time grid
    html += '<div class="cal-week-body">';
    for (let hour = 6; hour < 23; hour++) {
        const hourEvents = calEvents.filter(e => {
            if (!e.start_time || e.all_day) return false;
            return e.date === dateStr && parseInt(e.start_time.split(":")[0]) === hour;
        });
        html += `<div class="cal-week-row">
            <div class="cal-week-gutter">${formatHour(hour)}</div>
            <div class="cal-week-cell" data-date="${dateStr}" data-hour="${hour}">`;
        hourEvents.forEach(ev => {
            const duration = ev.end_time ? calcDuration(ev.start_time, ev.end_time) : 1;
            const topOffset = parseInt(ev.start_time.split(":")[1]) / 60 * 100;
            html += `<div class="cal-week-event ${esc(ev.color || 'blue')}" data-id="${ea(ev.id)}" style="top:${topOffset}%;height:${duration * 100}%">
                <div class="cal-week-event-time">${formatTime12(ev.start_time)}</div>
                <div class="cal-week-event-title">${esc(ev.title)}</div>
            </div>`;
        });
        html += `</div></div>`;
    }
    html += '</div></div>';

    $("cal-grid-wrapper").innerHTML = html;

    // Bind clicks on time cells
    document.querySelectorAll(".cal-week-cell").forEach(cell => {
        cell.onclick = (e) => {
            if (e.target.closest(".cal-week-event")) return;
            openEventModal(cell.dataset.date, cell.dataset.hour + ":00");
        };
    });
    document.querySelectorAll(".cal-week-event, .cal-week-allday-cell .cal-event-chip").forEach(ev => {
        ev.onclick = (e) => {
            e.stopPropagation();
            const id = ev.dataset.id;
            if (id && id.startsWith("task-")) openTaskDetail(id.replace("task-", ""));
            else if (id) openEventDetailModal(id);
        };
    });

    // Current time line
    if (isToday) {
        const now = new Date();
        const nowH = now.getHours(), nowM = now.getMinutes();
        if (nowH >= 6 && nowH < 23) {
            const rows = document.querySelectorAll(".cal-week-row");
            const row = rows[nowH - 6];
            if (row) {
                const cell = row.querySelector(".cal-week-cell");
                if (cell) {
                    const pct = (nowM / 60) * 100;
                    const line = document.createElement("div");
                    line.className = "cal-now-line";
                    line.style.cssText = `position:absolute;left:0;right:0;top:${pct}%;height:2px;background:#dc5050;z-index:10;pointer-events:none;`;
                    const dot = document.createElement("div");
                    dot.style.cssText = `position:absolute;left:-4px;top:-3px;width:8px;height:8px;border-radius:50%;background:#dc5050;`;
                    line.appendChild(dot);
                    cell.style.position = "relative";
                    cell.appendChild(line);
                }
            }
        }
    }

    // Auto-scroll to current time
    const body = document.querySelector(".cal-week-body");
    if (body) {
        const now = new Date();
        const rows = body.querySelectorAll(".cal-week-row");
        const targetIdx = Math.max(0, now.getHours() - 2) - 6;
        if (rows[targetIdx]) rows[targetIdx].scrollIntoView({ block: "start", behavior: "smooth" });
        else body.scrollTop = (Math.max(0, now.getHours() - 2) - 6) * 48;
    }
}

function renderMiniCalendar() {
    const year = calDate.getFullYear();
    const month = calDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = localDateStr(new Date());
    const monthLabel = calDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

    let html = `<div class="mini-cal-header">
        <button class="icon-btn sm" id="mini-cal-prev"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
        <span class="mini-cal-title">${esc(monthLabel)}</span>
        <button class="icon-btn sm" id="mini-cal-next"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
    </div>`;
    html += '<div class="mini-cal-grid">';
    ["S","M","T","W","T","F","S"].forEach(d => {
        html += `<div class="mini-cal-hdr">${d}</div>`;
    });
    for (let i = 0; i < firstDay; i++) html += `<div class="mini-cal-day empty"></div>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isToday = dateStr === todayStr;
        const hasEvents = calEvents.some(e => e.date === dateStr);
        html += `<div class="mini-cal-day ${isToday ? 'today' : ''} ${hasEvents ? 'has-events' : ''}" data-date="${dateStr}">${day}</div>`;
    }
    html += '</div>';

    $("mini-calendar").innerHTML = html;

    // Bind mini calendar navigation
    const prevBtn = document.getElementById("mini-cal-prev");
    const nextBtn = document.getElementById("mini-cal-next");
    if (prevBtn) prevBtn.onclick = () => { calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); };
    if (nextBtn) nextBtn.onclick = () => { calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); };

    // Bind day clicks — open that day in day view
    document.querySelectorAll(".mini-cal-day:not(.empty)").forEach(el => {
        el.onclick = () => {
            calDate = new Date(el.dataset.date + "T12:00:00");
            calView = "day";
            document.querySelectorAll(".cal-view-btn").forEach(b => b.classList.toggle("active", b.dataset.view === "day"));
            renderCalendar();
        };
    });
}

// Event modal
function openEventModal(date, time) {
    editingEventId = null;
    $("event-modal-title").textContent = "New Event";
    $("event-modal-delete").style.display = "none";
    $("event-detail-title").value = "";
    $("event-detail-date").value = date || localDateStr(new Date());
    $("event-detail-start").value = time || "";
    $("event-detail-end").value = "";
    $("event-detail-allday").checked = !time;
    $("event-detail-location").value = "";
    $("event-detail-desc").value = "";
    $("event-detail-color").value = "blue";
    openOverlay("event-overlay");
    $("event-detail-title").focus();
}

async function openEventDetailModal(eventId) {
    editingEventId = eventId;
    try {
        const r = await apiFetch(`/api/events`);
        const d = await r.json();
        const event = (d.events || []).find(e => e.id === eventId);
        if (!event) return;
        $("event-modal-title").textContent = "Edit Event";
        $("event-modal-delete").style.display = "";
        $("event-detail-title").value = event.title || "";
        $("event-detail-date").value = event.date || "";
        $("event-detail-start").value = event.start_time || "";
        $("event-detail-end").value = event.end_time || "";
        $("event-detail-allday").checked = event.all_day || false;
        $("event-detail-location").value = event.location || "";
        $("event-detail-desc").value = event.description || "";
        $("event-detail-color").value = event.color || "blue";
        openOverlay("event-overlay");
    } catch {}
}

$("event-detail-save").onclick = async () => {
    const title = $("event-detail-title").value.trim();
    if (!title) return;
    const body = {
        title,
        date: $("event-detail-date").value,
        start_time: $("event-detail-start").value || null,
        end_time: $("event-detail-end").value || null,
        all_day: $("event-detail-allday").checked,
        location: $("event-detail-location").value.trim(),
        description: $("event-detail-desc").value.trim(),
        color: $("event-detail-color").value,
    };
    if (editingEventId) {
        await apiFetch(`/api/events/${encodeURIComponent(editingEventId)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } else {
        await apiFetch("/api/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }
    closeOverlay("event-overlay");
    renderCalendar();
};

$("event-detail-cancel").onclick = () => closeOverlay("event-overlay");
$("event-modal-close").onclick = () => closeOverlay("event-overlay");
$("event-overlay").onclick = e => { if (e.target.id === "event-overlay") closeOverlay("event-overlay"); };

$("event-modal-delete").onclick = () => {
    if (!editingEventId) return;
    confirmAction("Delete this event?", async () => {
        await apiFetch(`/api/events/${encodeURIComponent(editingEventId)}`, { method: "DELETE" });
        closeOverlay("event-overlay");
        renderCalendar();
    });
};

// Calendar helpers
function formatTime12(time) {
    if (!time) return "";
    const [h, m] = time.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatHour(h) {
    if (h === 0) return "12 AM";
    if (h < 12) return `${h} AM`;
    if (h === 12) return "12 PM";
    return `${h - 12} PM`;
}

function calcDuration(start, end) {
    if (!start || !end) return 1;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    return Math.max(0.5, (eh * 60 + em - sh * 60 - sm) / 60);
}
