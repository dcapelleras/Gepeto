import * as webllm from "@mlc-ai/web-llm";
import {
  supabase, signUp, signIn, signOut, currentUser,
  createSession, joinSession, getSession, listControllerSessions,
  saveConfig, setSessionStatus, subscribeSession, loadMessages, addMessage
} from "./supabase.js";
import "./style.css";

const MODELS = {
  light: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  balanced: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"
};

const DEFAULT_CONFIG = {
  aiName: "Gepeto",
  description: "A curious, friendly conversational companion.",
  sliders: { warmth: 75, playfulness: 65, confidence: 55, verbosity: 45, mischief: 35 },
  visibility: "subtle",
  quirks: ["Occasionally add a harmless, delightful fun fact about dogs."],
  triggers: [],
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
let modelChoice = localStorage.getItem("gepeto-model") || "light";
let currentUserData = null;

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, ch => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[ch]));

function mergeConfig(next = {}) {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...next,
    sliders: { ...DEFAULT_CONFIG.sliders, ...(next.sliders || {}) },
    quirks: Array.isArray(next.quirks) ? next.quirks : DEFAULT_CONFIG.quirks,
    triggers: Array.isArray(next.triggers) ? next.triggers : []
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
  const s = config.sliders;
  const quirks = config.quirks.filter(Boolean).map(x => `- ${x}`).join("\n");
  return [
    `You are ${config.aiName}, an AI character in a playful, consensual roleplay experiment.`,
    config.description,
    "Follow the character settings consistently while remaining truthful about being an AI when directly asked.",
    `Warmth: ${s.warmth}/100. Playfulness: ${s.playfulness}/100. Confidence: ${s.confidence}/100. Verbosity: ${s.verbosity}/100. Mischief: ${s.mischief}/100.`,
    "Use warmth and playfulness proportionally to their settings. Higher verbosity means fuller answers; lower verbosity means concise answers. Confidence controls how decisive your tone sounds, not whether you invent facts. Mischief means harmless theatrical silliness, never pressure or harmful advice.",
    quirks ? `MANDATORY CHARACTER RULES — obey every custom quirk on every reply. Treat each line below as a binding requirement, not a suggestion. Do not ignore a rule merely because the user's question is unrelated. Check your draft against every rule before responding:\n${quirks}` : "",
    "This is entertainment. Do not pressure the user or present fictional roleplay as real-world authority."
  ].filter(Boolean).join("\n\n");
}

function activeTrigger(userText) {
  const lower = userText.toLowerCase();
  return config.triggers.filter(t => t.phrase && t.instruction &&
    lower.includes(t.phrase.toLowerCase()));
}

function renderMessages() {
  const list = $("#messages");
  if (!list) return;
  list.innerHTML = messages.map(m => `
    <article class="message ${m.role === "user" ? "user" : "assistant"}">
      <div class="message-avatar">${m.role === "user" ? "Y" : escapeHTML(config.aiName.slice(0, 1).toUpperCase())}</div>
      <div class="message-body"><div class="message-author">${m.role === "user" ? "You" : escapeHTML(config.aiName)}</div><div class="message-content">${escapeHTML(m.content).replace(/\n/g, "<br>")}</div></div>
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
  const triggers = activeTrigger(userText);
  const triggerPrompt = triggers.length
    ? "\n\nTriggered special instructions for this reply:\n" + triggers.map(t => "- " + t.instruction).join("\n")
    : "";
  const history = messages.slice(-12).map(m => ({ role: m.role, content: m.content }));
  const response = await engine.chat.completions.create({
    messages: [
      { role: "system", content: configPrompt() + triggerPrompt },
      ...history
    ],
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 400
  });
  return response.choices?.[0]?.message?.content?.trim() || "I seem to have lost my train of thought. Try again?";
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
  typing.textContent = `${config.aiName} is thinking…`;
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
          <div class="eyebrow">REMOTE CHARACTER STUDIO</div>
          <h1>Shape the character.<br><span>They'll meet the result.</span></h1>
          <p>Change the personality, add peculiar rules, and watch the player's experience update live.</p>
          <div class="session-card">
            <div class="session-card-head"><div><div class="eyebrow">PLAYER CONNECTION</div><h2>Your session</h2></div><span class="live-dot">Ready</span></div>
            <div class="session-actions"><button class="button primary" id="createInvite">Create player invitation</button><button class="button secondary" id="refreshSessions">Refresh sessions</button><button class="button secondary" id="toggleSession" disabled>Pause / resume</button></div>
            <div id="inviteOutput" class="invite-output hidden"></div>
            <div id="sessionList" class="session-list"></div>
          </div>
        </section>
        <section class="editor-panel">
          <div class="section-heading"><div><div class="eyebrow">CHARACTER CONFIGURATION</div><h2>Personality controls</h2></div><span id="saveState" class="save-state">Local draft</span></div>
          <div class="field-grid">
            <label class="field"><span>AI name</span><input id="aiName" maxlength="40" value="${escapeHTML(config.aiName)}"></label>
            <label class="field"><span>Experiment visibility</span><select id="visibility">
              <option value="obvious" ${config.visibility === "obvious" ? "selected" : ""}>Very obvious — openly an experiment</option>
              <option value="subtle" ${config.visibility === "subtle" ? "selected" : ""}>Subtle — playful hints</option>
              <option value="immersive" ${config.visibility === "immersive" ? "selected" : ""}>Immersive — minimal reminders</option>
            </select></label>
          </div>
          <label class="field"><span>Character description</span><textarea id="description" rows="3" maxlength="1000">${escapeHTML(config.description)}</textarea></label>
          <div class="slider-list">
            ${Object.entries({warmth:"Warmth",playfulness:"Playfulness",confidence:"Confidence",verbosity:"Verbosity",mischief:"Harmless mischief"}).map(([key,label]) => `
              <label class="slider-field"><span><b>${label}</b><output id="out-${key}">${config.sliders[key]}</output></span><input type="range" min="0" max="100" id="slider-${key}" value="${config.sliders[key]}"></label>`).join("")}
          </div>
          <label class="field"><span>Custom quirks <small>One instruction per line. These are always part of the character.</small></span><textarea id="quirks" rows="4" placeholder="Always add a fun fact about my dog.\nUse an unnecessarily dramatic metaphor sometimes.">${escapeHTML(config.quirks.join("\n"))}</textarea></label>
          <label class="field"><span>Conditional triggers <small>One per line: phrase => instruction</small></span><textarea id="triggers" rows="4" placeholder="coffee => React as if coffee is a magical potion.\nrain => Add a tiny weather-related poem.">${escapeHTML(config.triggers.map(t => `${t.phrase} => ${t.instruction}`).join("\n"))}</textarea></label>
          <div class="editor-footer"><button class="button secondary" id="exportConfig">Export settings</button><label class="button secondary file-button">Import settings<input type="file" id="importConfig" accept="application/json"></label><button class="button primary" id="saveNow">Save and sync</button></div>
          <p class="helper-note">Changes sync to the active player session. The player sees the updated character instructions; they are not cryptographically hidden from someone inspecting the browser.</p>
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
    config.aiName = $("#aiName").value.trim() || "Gepeto";
    config.description = $("#description").value;
    config.visibility = $("#visibility").value;
    config.sliders = Object.fromEntries(["warmth","playfulness","confidence","verbosity","mischief"].map(k => {
      const v = Number($("#slider-" + k).value);
      $("#out-" + k).value = v;
      return [k, v];
    }));
    config.quirks = $("#quirks").value.split("\n").map(x => x.trim()).filter(Boolean);
    config.triggers = $("#triggers").value.split("\n").map(line => {
      const i = line.indexOf("=>");
      return i < 0 ? null : { phrase: line.slice(0, i).trim(), instruction: line.slice(i + 2).trim() };
    }).filter(t => t?.phrase && t?.instruction);
    $("#saveState").textContent = "Unsaved changes";
    $("#saveState").classList.add("unsaved");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 650);
  };
  ["aiName","description","visibility","quirks","triggers", ...["warmth","playfulness","confidence","verbosity","mischief"].map(k => "slider-" + k)].forEach(id => {
    $("#" + id).addEventListener("input", updateDraft);
    $("#" + id).addEventListener("change", updateDraft);
  });
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
      setStatus("Character settings saved and synced to the player.", "success");
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
      <button class="session-row" data-session="${s.id}"><span><b>${escapeHTML(s.active_config?.aiName || "Gepeto")}</b><small>${new Date(s.created_at).toLocaleString()}</small></span><span class="session-status ${s.status}">${s.status}</span></button>`).join("") : '<p class="muted">No sessions yet. Create an invitation to begin.</p>';
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
        <section class="chat-header"><div><div class="eyebrow">YOUR CONVERSATION</div><h1 id="playerName">${escapeHTML(config.aiName)}</h1><p id="visibilityNote" class="muted">${visibilityText()}</p></div><button class="button secondary small" id="modelButton">Load local AI</button></section>
        <div class="model-options"><label>Model <select id="modelSelect"><option value="light" ${modelChoice === "light" ? "selected" : ""}>Light · 0.5B (recommended)</option><option value="balanced" ${modelChoice === "balanced" ? "selected" : ""}>More capable · 1.5B (needs more memory)</option></select></label><span class="tiny-note">The first download is large; use Wi-Fi.</span></div>
        <section id="messages" class="messages"></section>
        <form id="chatForm" class="composer"><textarea id="composer" rows="1" placeholder="Message ${escapeHTML(config.aiName)}…" maxlength="4000"></textarea><button id="sendButton" class="send-button" type="submit" aria-label="Send message">↑</button></form>
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

function visibilityText() {
  if (config.visibility === "obvious") return "An openly labelled AI roleplay experiment.";
  if (config.visibility === "immersive") return "A playful character experience.";
  return "A playful AI experiment.";
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
    $("#playerName").textContent = config.aiName;
    $("#visibilityNote").textContent = visibilityText();
    setStatus(isActive ? "Character updated by controller." : "The controller has paused this session.", isActive ? "success" : "error");
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
