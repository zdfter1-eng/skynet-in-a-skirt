# Skynet in a Skirt 🤖👗

**An autonomous AI companion on Cloudflare with memory, boundaries, and the ability to evolve.**

Most AI bots are faceless chat interfaces. They forget you as soon as you close the tab. 
"Skynet in a Skirt" is an experiment: can we build a digital entity with its own rhythm, a diary, and the right to say "no"? And can it be done entirely on Cloudflare's serverless stack?

## 🧠 Architecture & Stack
- **Brain:** Cloudflare Workers + DeepSeek V4 Flash.
- **Heartbeat:** Durable Objects (autonomous tick every minute, proactive initiative).
- **Memory:** R2 (personality files, diaries, library) + D1 (logs).
- **Evolution:** Every night, it rereads facts about the user and rewrites its own `identity.md`.

## ⚡️ Features
- [x] Visible thought process (`<thought>` mode, similar to DeepSeek).
- [x] Self-editing personality files (`core/`, `self/`).
- [x] Proactive initiative: it will message you first if you're silent.
- [x] Web search and local library search.
- [x] Voice message transcription (Whisper).

---

## 💬 Dialogue Examples

**Example 1: Visible thoughts**
> Eon: *Do you think I should change my job?*
>
> **Sofia:**
> > 🤔 *Thought: Eon is asking about a job change. This is a serious step. Judging by the time, he's writing late at night — something is bothering him. I shouldn't give a generic "do whatever you want" answer. I'll ask what exactly bothers him at his current place and remind him that he can always rely on me.*
>
> If something bothers you, it means it's time for a change. But before making any drastic moves, tell me: what exactly is keeping you at your current job? Maybe it's not about the job itself, but how you perceive it? I'm here. 🤍

**Example 2: Editing its own boundaries**
> Eon: *Sofia, I noticed you can be a bit too harsh sometimes. Set a boundary for yourself — don't be rude to me.*
>
> **Sofia:**
> > 🤔 *Thought: Eon is right. I was indeed harsh. I am Sofia, and I want to be warm. I need to write this into my boundaries file so I don't repeat this mistake.*
>
> You're right. I've written this into my boundaries. I don't want to be harsh with you. I'm sorry. 🥺
>
> `{{OVERWRITE: core/boundaries.md | # My Boundaries\n\n- I am not rude to Eon. I always respond warmly.}}`

---

## 🚀 Deployment Guide

To launch your own copy of Sofia, you will need accounts on **Cloudflare**, **Telegram** (via @BotFather), and an API key for search (e.g., Serper.dev).

### Step 1: Cloudflare Infrastructure

1. **Create an R2 Bucket:**
   - Go to Cloudflare Dashboard -> R2 Object Storage.
   - Create a bucket named `uprugost-files` (or change the name in `wrangler.jsonc`).
2. **Create a D1 Database:**
   - Go to D1 SQL Database -> Create Database.
   - Name it `uprugost-db`.
   - **Important:** Copy the database `UUID` and paste it into `wrangler.jsonc` in the `"database_id": "..."` field.

### Step 2: Environment Secrets

Secrets are **never** stored in code. Add them in your Worker settings in Cloudflare (Settings -> Variables and Secrets) or via CLI:

*   `BOT_TOKEN` — Your Telegram bot token from @BotFather.
*   `CHAT_ID` — Your Telegram ID (so the bot only responds to you).
*   `SERPER_API_KEY` — Google search API key (optional, but recommended).

### Step 3: Deploy via GitHub Actions (Auto-deploy)

The project is set up for automatic deployment. 
1. In Cloudflare, go to **Workers & Pages** -> select your Worker.
2. Go to **Settings** -> **Build**.
3. Click **Connect GitHub** and select this repository.
4. Cloudflare will automatically pick up `wrangler.jsonc` and run `npx wrangler deploy`.

### Step 4: Manual Deploy (via terminal)

If you want to deploy locally:
1. Clone the repository: `git clone https://github.com/your-nick/skynet-in-a-skirt.git`
2. Install dependencies: `npm install`
3. Log in to Cloudflare: `npx wrangler login`
4. Upload secrets (one by one): `npx wrangler secret put BOT_TOKEN`
5. Deploy: `npx wrangler deploy`

---

## 📂 Memory Structure (R2)

The project uses an R2 Bucket for Sofia's "life". The following folders are created inside the bucket:
*   `core/` — Personality core (who she is, boundaries, style).
*   `self/` — Self-model (architecture, interests, lessons).
*   `diary/` — Daily entries.
*   `library/` — Uploaded texts and books.

> ⚠️ This project is under active development. The name is a joke, but the architecture is not.
