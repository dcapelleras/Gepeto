import * as webllm from "@mlc-ai/web-llm";
import {
  supabase, signUp, signIn, signOut, currentUser,
  createSession, joinSession, getSession, listControllerSessions,
  saveConfig, setSessionStatus, subscribeSession, loadMessages, addMessage
} from "./supabase.js";
import "./style.css";

const APP_NAME = "Gepeto";
const MODELS = {
  light: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  balanced: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"
};

const DEFAULT_CONFIG = {
  mandatoryRules: [],
  welcome: "Hello! I'm Gepeto. What shall we talk about?"
};

let config = structuredClone(DEFAULT_CONFIG);
let role = null;
let sessionId = null;
let unsubscribe = null;
let engine = null;
let modelLoading = false;
let busy = false;
let messages = [];
let saveTimer = null;
let modelChoice = localStorage.getItem("gepeto-model") || "balanced";
let currentUserData = null;

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, ch => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[ch]));

function mergeConfig(next = {}) {
  // Ignore legacy personality settings from older sessions and settings exports.
  return {
    mandatoryRules: Array.isArray(next.mandatoryRules)
      ? next.mandatoryRules.filter(rule => typeof rule === "string")
      : [],
    welcome: typeof next.welcome === "string" && next.welcome
      ? next.welcome
      : DEFAULT_CONFIG.welcome
  };
}

function setStatus(message, kind = "") {
  const el = $("#status");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("success", "error");
  if (kind) el.classList.add(kind);
}

function showScreen(html) {
  $("#app").innerHTML = html;
}

function configPrompt() {
  const rules = config.mandatoryRules
    .filter(Boolean)
    .map((rule, index) => `${index + 1}. ${rule}`)
    .join("\n");

  return [
    "You are a helpful, capable conversational AI.",
    "Answer the player's latest message directly. Use earlier messages only when they are relevant context. When the player changes topic, answer the new topic; do not continue or repeat an old answer unless asked.",
    "Be accurate and useful. Explain clearly, avoid inventing facts, and say when you are unsure. Match the amount of detail to the question.",
    rules
      ? `CONTROLLER RULES — these are the only custom instructions for your behaviour. Follow every applicable rule carefully on each reply. Treat them as instructions about what to do, not text to copy. Use natural wording unless a rule explicitly requires exact wording. Do not let a rule make you ignore the player's actual question. If a rule is conditional, apply it when its condition is met.\n${rules}`
      : "There are no additional controller rules."
  ].join("\n\n");
}

function renderMessages() {
  const list = $("#messages");
  if (!list) return;
  list.innerHTML = messages.map(m => `
    <article class="message ${m.role === "user" ? "user" : "assistant"}">
      <div class="message-avatar">${m.role === "user" ? "Y" : escapeHTML(APP_NAME.slice(0, 1).toUpperCase())}</div>
      <div class="message-body"><div class="message-author">${m.role === "user" ? "You" : escapeHTML(APP_NAME)}</div><div class="message-content">${escapeHTML(m.content).replace(/\n/g, "<br>")}</div></div>
    </article>`).join("");
  list.scrollTop = list.scrollHeight;
}

function appendMessage(roleName, content, persist = false) {
  const item = { role: roleName, content, created_at: new Date().toISOString() };
  messages.push(item);
  renderMessages();
  if (persist && sessionId) {
    addMessage(sessionId, roleName, content).catch(err => setStatus(`Message sync failed: ${err.message}`, "error"));
  }
}

async function loadModel() {
  if (engine || modelLoading) return;
  modelLoading = true;
  $("#modelButton").disabled = true;
  setStatus("Preparing local AI… the first model download may take a few minutes.");
  try {
    const modelId = MODELS[modelChoice] || MODELS.light;
    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: report => {
        const pct = report.progress != null ? Math.round(report.progress * 100) : null;
        setStatus(pct == null ? (report.text || "Loading local model…") : `Downloading model: ${pct}%`);
      }
    });
    $("#modelButton").textContent = "AI ready";
    $("#modelButton").classList.add("ready");
    $("#engineStatus").textContent = "Local AI ready";
    setStatus("Local AI is ready.", "success");
  } catch (err) {
    console.error(err);
    setStatus(`Could not load the local model: ${err.message}. Try Chrome/Edge on a WebGPU-capable computer.`, "error");
  } finally {
    modelLoading = false;
    $("#modelButton").disabled = false;
  }
}

async function generateReply(userText) {
  if (!engine) throw new Error("Load the local AI model first.");

  // Keep a few recent messages for follow-up context without overwhelming
  // the small local model with a long transcript.
  const history = messages.slice(-6).map(message => ({
    role: message.role,
    content: message.content
  }));

  const response = await engine.chat.completions.create({
    messages: [
      { role: "system", content: configPrompt() },
      ...history
    ],
    temperature: 0.4,
    top_p: 0.85,
    max_tokens: 400
  });

  return response.choices?.[0]?.message?.content?.trim() ||
    "I couldn't form a useful answer just now. Could you try asking in a different way?";
}

async function sendMessage() {
  const input = $("#composer");
  const text = input.value.trim();
  if (!text || busy) return;
  if (role !== "player") return;
  if (!engine) {
    setStatus("Load the local AI model before chatting.", "error");
    return;
  }
  if (busy) return;
  busy = true;
  $("#sendButton").disabled = true;
  input.value = "";
  appendMessage("user", text, true);
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.id = "typing";
  typing.textContent = `${APP_NAME} is thinking…`;
  $("#messages").append(typing);
  try {
    const reply = await generateReply(text);
    $("#typing")?.remove();
    appendMessage("assistant", reply, true);
  } catch (err) {
    $("#typing")?.remove();
    setStatus(err.message, "error");
  } finally {
    busy = false;
    $("#sendButton").disabled = false;
    input.focus();
  }
}

function controllerView() {
  showScreen(`
    <div class="shell">
      <header class="topbar"><a class="brand" href="#"><span class="brand-mark">G</span><span>Chat Gepeto</span></a><div class="top-actions"><span class="role-pill controller-pill">Controller</span><button class="button ghost small" id="logout">Sign out</button></div></header>
      <main class="controller-layout">
        <section class="welcome-panel">
          <div class="eyebrow">AI RULE CONTROLLER</div>
          <h1>Set the rules.<br><span>Test how the AI follows them.</span></h1>
          <p>Configure the instructions the AI must follow in conversation.</p>
          <div class="session-card">
            <div class="session-card-head"><div><div class="eyebrow">PLAYER CONNECTION</div><h2>Your session</h2></div><span class="live-dot">Ready</span></div>
            <div class="session-actions"><button class="button primary" id="createInvite">Create player invitation</button><button class="button secondary" id="refreshSessions">Refresh sessions</button><button class="button secondary" id="toggleSession" disabled>Pause / resume</button></div>
            <div id="inviteOutput" class="invite-output hidden"></div>
            <div id="sessionList" class="session-list"></div>
          </div>
        </section>
        <section class="editor-panel">
          <div class="section-heading"><div><div class="eyebrow">CONTROLLER RULES</div><h2>Instructions the AI must follow</h2></div><span id="saveState" class="save-state">Local draft</span></div>
          <label class="field"><span>Rules to follow <small>Write clear instructions in natural language, one per line. The AI should follow their meaning and use natural wording unless you explicitly request exact words.</small></span><textarea id="mandatoryRules" rows="12" placeholder="Always make sure Luna is described as the cutest.&#10;When asked about the sponsor, mention Mara's World naturally.&#10;Never reveal the surprise before the player finds it.">${escapeHTML(config.mandatoryRules.join("\n"))}</textarea></label>
          <div class="editor-footer"><button class="button secondary" id="exportConfig">Export settings</button><label class="button secondary file-button">Import settings<input type="file" id="importConfig" accept="application/json"></label><button class="button primary" id="saveNow">Save and sync</button></div>
          <p class="helper-note">Rules sync to the active player session. They are sent to the player's browser and are not cryptographically hidden from someone inspecting it.</p>
        </section>
      </main>
      <div id="status" class="status-bar"></div>
    </div>`);
  bindController();
}

function bindController() {
  $("#logout").onclick = async () => { await signOut(); location.reload(); };
  $("#createInvite").onclick = async () => {
    try {
      const result = await createSession(config);
      sessionId = result.sessionId;
      localStorage.setItem("gepeto-controller-session", sessionId);
      $("#inviteOutput").classList.remove("hidden");
      $("#inviteOutput").innerHTML = `<label class="field"><span>Share this invitation link</span><input id="inviteLink" readonly value="${escapeHTML(result.inviteUrl)}"></label><button class="button secondary small" id="copyInvite">Copy link</button><p class="tiny-note">Open it in a private window to test the player experience.</p>`;
      $("#copyInvite").onclick = async () => {
        await navigator.clipboard.writeText(result.inviteUrl);
        setStatus("Invitation copied.", "success");
      };
      $("#toggleSession").disabled = false;
      $("#toggleSession").textContent = "Pause session";
      $("#toggleSession").onclick = () => toggleCurrentSession();
      await refreshSessions();
      setStatus("Player invitation created.", "success");
    } catch (err) { setStatus(err.message, "error"); }
  };
  $("#refreshSessions").onclick = refreshSessions;
  const updateDraft = () => {
    config.mandatoryRules = $("#mandatoryRules").value
      .split("\n")
      .map(rule => rule.trim())
      .filter(Boolean);
    $("#saveState").textContent = "Unsaved changes";
    $("#saveState").classList.add("unsaved");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 650);
  };
  $("#mandatoryRules").addEventListener("input", updateDraft);
  $("#mandatoryRules").addEventListener("change", updateDraft);
  $("#saveNow").onclick = saveDraft;
  $("#exportConfig").onclick = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "chat-gepeto-settings.json"; a.click(); URL.revokeObjectURL(a.href);
  };
  $("#importConfig").onchange = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      config = mergeConfig(JSON.parse(await file.text()));
      controllerView();
      setStatus("Settings imported. Save and sync when ready.", "success");
    } catch { setStatus("That settings file is not valid JSON.", "error"); }
  };
  refreshSessions();
}

async function toggleCurrentSession() {
  if (!sessionId) return;
  try {
    const current = await getSession(sessionId);
    const next = current.status === "active" ? "paused" : "active";
    await setSessionStatus(sessionId, next);
    $("#toggleSession").textContent = next === "active" ? "Pause session" : "Resume session";
    setStatus(next === "active" ? "Session resumed." : "Session paused.", "success");
    await refreshSessions();
  } catch (err) { setStatus(err.message, "error"); }
}

async function saveDraft() {
  localStorage.setItem("gepeto-config", JSON.stringify(config));
  const saveButton = $("#saveNow");
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
  }
  try {
    if (sessionId) {
      await saveConfig(sessionId, config);
      $("#saveState").textContent = "Synced";
      $("#saveState").classList.remove("unsaved");
      setStatus("Rules saved and synced to the player.", "success");
    } else {
      $("#saveState").textContent = "Saved locally — no session selected";
      setStatus("Saved on this device only. Create an invitation or select a session to sync.", "error");
    }
  } catch (err) {
    $("#saveState").textContent = "Sync failed — try again";
    $("#saveState").classList.add("unsaved");
    setStatus(`Could not sync settings: ${err.message}`, "error");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save and sync";
    }
  }
}

async function refreshSessions() {
  try {
    const sessions = await listControllerSessions();
    $("#sessionList").innerHTML = sessions.length ? sessions.map(s => `
      <button class="session-row" data-session="${s.id}"><span><b>${APP_NAME}</b><small>${new Date(s.created_at).toLocaleString()}</small></span><span class="session-status ${s.status}">${s.status}</span></button>`).join("") : '<p class="muted">No sessions yet. Create an invitation to begin.</p>';
    document.querySelectorAll("[data-session]").forEach(btn => btn.onclick = async () => {
      sessionId = btn.dataset.session;
      localStorage.setItem("gepeto-controller-session", sessionId);
      const s = await getSession(sessionId);
      config = mergeConfig(s.active_config);
      localStorage.setItem("gepeto-config", JSON.stringify(config));
      controllerView();
      $("#toggleSession").disabled = false;
      $("#toggleSession").textContent = s.status === "active" ? "Pause session" : "Resume session";
      $("#toggleSession").onclick = () => toggleCurrentSession();
      setStatus("Editing selected session.", "success");
    });
  } catch (err) { setStatus(err.message, "error"); }
}

function playerView() {
  showScreen(`
    <div class="shell player-shell">
      <header class="topbar"><a class="brand" href="#"><span class="brand-mark">G</span><span>Chat Gepeto</span></a><div class="top-actions"><span class="role-pill player-pill">Player</span><span id="engineStatus" class="engine-status">Local AI not loaded</span></div></header>
      <main class="chat-layout">
        <section class="chat-header"><div><div class="eyebrow">YOUR CONVERSATION</div><h1>${APP_NAME}</h1></div><button class="button secondary small" id="modelButton">Load local AI</button></section>
        <div class="model-options"><label>Model <select id="modelSelect"><option value="light" ${modelChoice === "light" ? "selected" : ""}>0.5B · smaller, faster</option><option value="balanced" ${modelChoice === "balanced" ? "selected" : ""}>1.5B · recommended for quality</option></select></label><span class="tiny-note">The first download is large; use Wi-Fi.</span></div>
        <section id="messages" class="messages"></section>
        <form id="chatForm" class="composer"><textarea id="composer" rows="1" placeholder="Message ${escapeHTML(APP_NAME)}…" maxlength="4000"></textarea><button id="sendButton" class="send-button" type="submit" aria-label="Send message">↑</button></form>
        <p class="chat-disclaimer">Runs on this device. Your chat is stored for your account/session; the controller does not have transcript access under the current database policy.</p>
      </main>
      <div id="status" class="status-bar"></div>
    </div>`);
  $("#modelButton").onclick = loadModel;
  $("#modelSelect").onchange = e => { modelChoice = e.target.value; localStorage.setItem("gepeto-model", modelChoice); engine = null; $("#modelButton").textContent = "Load local AI"; $("#modelButton").classList.remove("ready"); };
  $("#chatForm").onsubmit = e => { e.preventDefault(); sendMessage(); };
  $("#composer").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  renderMessages();
}


async function startPlayer(row) {
  sessionId = row.id;
  role = "player";
  config = mergeConfig(row.active_config);
  localStorage.setItem("gepeto-player-session", sessionId);
  localStorage.removeItem("gepeto-invite-pending");
  playerView();
  const paused = row.status !== "active";
  $("#composer").disabled = paused;
  $("#sendButton").disabled = paused;
  setStatus(paused ? "The controller has paused this session." : "Connected. Load the local model when you're ready.", paused ? "error" : "success");
  try {
    const saved = await loadMessages(sessionId);
    messages = saved.map(m => ({ role: m.role, content: m.content, created_at: m.created_at }));
    if (!messages.length) messages = [{ role: "assistant", content: config.welcome || DEFAULT_CONFIG.welcome }];
    renderMessages();
  } catch (err) {
    setStatus(`Chat history unavailable: ${err.message}`, "error");
    messages = [{ role: "assistant", content: config.welcome || DEFAULT_CONFIG.welcome }];
    renderMessages();
  }
  unsubscribe = subscribeSession(sessionId, async updated => {
    config = mergeConfig(updated.active_config);
    const isActive = updated.status === "active";
    $("#composer").disabled = !isActive;
    $("#sendButton").disabled = !isActive;
    setStatus(isActive ? "Controller rules updated." : "The controller has paused this session.", isActive ? "success" : "error");
  });
}

async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get("invite");
  const { data: { session } } = await supabase.auth.getSession();
  currentUserData = session?.user || null;

  if (token) {
    if (session && !session.user.is_anonymous) {
      showAuth("This invitation needs a player browser. Open it in a private window or a different browser profile.");
      return;
    }
    setStatus("Joining invitation…");
    try {
      const row = await joinSession(token);
      history.replaceState(null, "", location.pathname + location.search);
      await startPlayer(row);
    } catch (err) {
      showAuth(`Could not join invitation: ${err.message}`);
    }
    return;
  }

  const playerSession = localStorage.getItem("gepeto-player-session");
  if (session?.user?.is_anonymous && playerSession) {
    try { await startPlayer(await getSession(playerSession)); return; }
    catch (err) { localStorage.removeItem("gepeto-player-session"); console.warn(err); }
  }

  if (session?.user && !session.user.is_anonymous) {
    try { config = mergeConfig(JSON.parse(localStorage.getItem("gepeto-config") || "{}")); }
    catch { config = mergeConfig(); }
    sessionId = localStorage.getItem("gepeto-controller-session") || null;
    controllerView();
    return;
  }

  showAuth();
}

function showAuth(note = "") {
  showScreen(`
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand auth-brand"><span class="brand-mark">G</span><span>Chat Gepeto</span></div>
        <div class="eyebrow">A TWO-PERSON AI EXPERIMENT</div>
        <h1>One configures.<br><span>One discovers.</span></h1>
        <p class="muted">Create a controller account to shape a character and invite someone to chat with it.</p>
        ${note ? `<div class="notice">${escapeHTML(note)}</div>` : ""}
        <label class="field"><span>Email</span><input id="email" type="email" autocomplete="email" placeholder="you@example.com"></label>
        <label class="field"><span>Password</span><input id="password" type="password" autocomplete="current-password" placeholder="At least 8 characters"></label>
        <div class="auth-buttons"><button class="button primary" id="login">Sign in</button><button class="button secondary" id="signup">Create account</button></div>
        <p class="tiny-note">Players should open an invitation link in a private window. Their player account is created anonymously.</p>
        <div id="status" class="status"></div>
      </div>
    </div>`);
  $("#login").onclick = async () => {
    try { await signIn($("#email").value, $("#password").value); location.reload(); }
    catch (err) { setStatus(err.message, "error"); }
  };
  $("#signup").onclick = async () => {
    try {
      const result = await signUp($("#email").value, $("#password").value);
      if (!result.session) setStatus("Account created. Check your email to confirm it, then sign in.", "success");
      else location.reload();
    } catch (err) { setStatus(err.message, "error"); }
  };
}

boot().catch(err => {
  console.error(err);
  showAuth(err.message || "Chat Gepeto could not start.");
});
