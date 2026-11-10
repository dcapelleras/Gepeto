# Chat Gepeto

A two-person AI roleplay app: one person configures the character, while another chats with it. The player-facing chat runs a small language model locally in a WebGPU-capable browser; Supabase synchronizes character settings between controller and player.

## Current status

This repository is the first consolidated application source. The browser UI, local model integration, controller authentication, invitation flow, and realtime config listener are included. It still requires a live end-to-end test in your Supabase project and a deployed HTTPS origin before it is ready to gift.

## Features

- GPT-inspired responsive chat interface.
- Controller account using Supabase email/password authentication.
- Anonymous player access through a high-entropy invitation link.
- Remote character configuration updates using Supabase Realtime.
- Personality and behaviour sliders, free-text custom quirks, conditional triggers, and experiment-visibility control.
- Local AI inference through WebLLM. Default: Qwen2.5 0.5B; optional Qwen2.5 1.5B for more capable hardware.
- Player chat records are private to the player under the current RLS policy; the controller does not get transcript access.
- Character configuration import/export.

## Requirements

- Node.js 20 or newer.
- Recent Chrome or Edge recommended.
- WebGPU-compatible hardware and browser for local AI inference.
- Internet access for the first model download and Supabase connection.
- A Supabase project with the Chat Gepeto schema and anonymous sign-ins enabled.

## Run locally

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` using the Supabase project URL and publishable key.
3. Install dependencies: `npm install`.
4. Start the development server: `npm run dev`.
5. Open the local URL printed by Vite.
6. Create a controller account, sign in, and create a player invitation.
7. Open the invitation in a separate browser profile or private window.
8. In player view, load the local AI model. The first download is substantial; later visits should use the browser cache.

## Supabase setup already completed in the original project

The expected tables are `gepeto_sessions`, `gepeto_session_members`, and `gepeto_messages`. RLS is enabled, six policies are present, the `create_gepeto_session(jsonb,text)` and `join_gepeto_session(text)` RPCs exist, Realtime publication includes `gepeto_sessions`, and the single-player index exists. The anonymous-player claim check was also verified. See `supabase/verify.sql` for a read-only check.

## Important security notes

- Only the Supabase publishable key belongs in `.env.local` / browser configuration. Never add a `service_role` or `sb_secret_` key to this repository.
- Invitation secrets are 256-bit random values placed in the URL fragment; only their SHA-256 hashes are stored in Supabase.
- A browser-based model must receive the character instructions to follow them. This hides them from the normal chat UI, not from a technically curious player inspecting their browser.
- Player chat messages are not visible to the controller under the installed message-read policy.
- Before gifting, test the exact controller/player flow and review the Supabase RLS policies. The source code is not a substitute for a security audit.

## Build

- `npm run build` creates the production site in `dist/`.
- Deploy `dist/` to a static host with HTTPS (for example, Vercel or Netlify).
- Add the same two public Supabase environment variables to the hosting project.
- Add the deployed site URL to Supabase Authentication's allowed redirect/site URL configuration if required.

## Model quality

The 0.5B model is intentionally selected for lower hardware requirements. Small models can be inconsistent with detailed instructions, and they are not equivalent to cloud ChatGPT. The 1.5B option needs more GPU memory and can provide better instruction following on suitable computers. Phone compatibility depends on the specific device and browser's WebGPU implementation.
