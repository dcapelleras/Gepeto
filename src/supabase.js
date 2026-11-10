import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error("Missing Supabase configuration. Copy .env.example to .env.local and fill in the project URL and publishable key.");
}

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export async function currentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user;
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function createSession(config) {
  const user = await currentUser();
  if (!user || user.is_anonymous) throw new Error("Sign in with your controller account first.");
  const token = randomToken();
  const inviteHash = await sha256(token);
  const { data: sessionId, error } = await supabase.rpc("create_gepeto_session", {
    p_config: config,
    p_player_invite_hash: inviteHash
  });
  if (error) throw error;
  return { sessionId, inviteUrl: `${location.origin}${location.pathname}#invite=${token}` };
}

export async function joinSession(token) {
  let { data: { session } } = await supabase.auth.getSession();
  if (session && !session.user.is_anonymous) {
    throw new Error("This browser is signed in as a controller. Open the invitation in a private window or a different browser profile.");
  }
  if (!session) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    session = data.session;
  }
  const inviteHash = await sha256(token);
  const { data: sessionId, error } = await supabase.rpc("join_gepeto_session", { p_invite_hash: inviteHash });
  if (error) throw error;
  const { data: row, error: readError } = await supabase
    .from("gepeto_sessions")
    .select("id, active_config, status")
    .eq("id", sessionId)
    .single();
  if (readError) throw readError;
  return row;
}

export async function getSession(sessionId) {
  const { data, error } = await supabase
    .from("gepeto_sessions")
    .select("id, active_config, status, created_at")
    .eq("id", sessionId)
    .single();
  if (error) throw error;
  return data;
}

export async function listControllerSessions() {
  const user = await currentUser();
  if (!user || user.is_anonymous) throw new Error("Controller sign-in required.");
  const { data, error } = await supabase
    .from("gepeto_sessions")
    .select("id, active_config, status, created_at")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function saveConfig(sessionId, config) {
  const { error } = await supabase
    .from("gepeto_sessions")
    .update({ active_config: config })
    .eq("id", sessionId);
  if (error) throw error;
}

export async function setSessionStatus(sessionId, status) {
  const { error } = await supabase
    .from("gepeto_sessions")
    .update({ status })
    .eq("id", sessionId);
  if (error) throw error;
}

export function subscribeSession(sessionId, callback) {
  const channel = supabase
    .channel(`gepeto-session-${sessionId}`)
    .on("postgres_changes", {
      event: "UPDATE", schema: "public", table: "gepeto_sessions", filter: `id=eq.${sessionId}`
    }, payload => callback(payload.new))
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export async function loadMessages(sessionId, limit = 80) {
  const { data, error } = await supabase
    .from("gepeto_messages")
    .select("id, role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function addMessage(sessionId, role, content) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error("Not authenticated.");
  const { error } = await supabase.from("gepeto_messages").insert({
    session_id: sessionId, user_id: user.id, role, content
  });
  if (error) throw error;
}

export function subscribeMessages(sessionId, callback) {
  const channel = supabase
    .channel(`gepeto-messages-${sessionId}`)
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "gepeto_messages", filter: `session_id=eq.${sessionId}`
    }, payload => callback(payload.new))
    .subscribe();
  return () => supabase.removeChannel(channel);
}
