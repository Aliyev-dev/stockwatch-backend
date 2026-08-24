# StockWatch backend

Central notification + user-management service for the StockWatch Chrome extension.

It is one always-on Node process that runs three things:

- **A Telegram bot** (Telegraf, long polling). Users press `/start`, get a personal
  **link code**, and receive their price alerts in that chat. The bot token lives only
  on this server — users never see or handle it.
- **A JSON API** (Express). The extension calls `POST /api/notify` with a user's link
  code to deliver an alert; admin endpoints expose users, messages and stats.
- **An admin panel** at `/admin` — a single server-served HTML page behind your
  `ADMIN_TOKEN`.

Support chat is built in: any text a user sends the bot is stored and forwarded to your
personal Telegram, and replying to that forwarded message relays your answer back to the
user.

---

## Table of contents

1. [Requirements](#requirements)
2. [1. Create the Supabase project](#1-create-the-supabase-project)
3. [2. Create the bot with BotFather](#2-create-the-bot-with-botfather)
4. [3. Find your own chat id](#3-find-your-own-chat-id)
5. [4. Configure the environment](#4-configure-the-environment)
6. [5. Run it](#5-run-it)
7. [Deploying (Railway / Render)](#deploying-railway--render)
8. [API reference](#api-reference)
9. [How the extension uses this](#how-the-extension-uses-this)
10. [Project layout](#project-layout)
11. [Operating notes](#operating-notes)
12. [Troubleshooting](#troubleshooting)

---

## Requirements

- Node.js 20 or newer
- A Supabase project (free tier is fine)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

```bash
npm install
```

---

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**. Pick a name, a database
   password (you will not need it here) and a region close to your users.
2. Wait for provisioning, then open **Project Settings → Data API** and copy the
   **Project URL** → this is `SUPABASE_URL`.
3. Open **Project Settings → API Keys** and copy the **`service_role`** key →
   this is `SUPABASE_SERVICE_KEY`.
   *Use the service role key, not the `anon` key.* It bypasses row-level security and must
   never be shipped to a browser or to the extension — it is only read by this server.
4. Open **SQL Editor → New query**, paste the entire contents of
   [`schema.sql`](./schema.sql), and press **Run**.

`schema.sql` creates `users`, `messages` and `notifications` with their indexes, the
`admin_user_overview` view used by the panel, and enables RLS with no public policies so
the `anon` key cannot read anything even if it leaks. The script is idempotent — re-running
it is safe.

---

## 2. Create the bot with BotFather

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Give it a display name and a username ending in `bot` (e.g. `StockWatchAlertsBot`).
3. BotFather replies with a token like `123456789:AAH...`. That is `TELEGRAM_BOT_TOKEN`.
   You can fetch it again later with `/mybots → your bot → API Token`.
4. Your users' registration link is `https://t.me/<your_bot_username>` — put that link in
   the extension. Opening it and pressing **Start** is the whole signup flow.

Optional polish, all inside BotFather: `/setdescription`, `/setabouttext`, `/setuserpic`.
The command list (`/start`, `/code`, `/help`) is registered automatically by this server on
every boot.

> Never commit the token. If it leaks, run `/revoke` in BotFather and update the env var.

---

## 3. Find your own chat id

`ADMIN_CHAT_ID` is *your* personal numeric Telegram id — where user reports get forwarded.

1. Open [@userinfobot](https://t.me/userinfobot) and press **Start**.
2. It replies with your `Id` (a number like `123456789`). That is `ADMIN_CHAT_ID`.
3. Also press **Start** on your own StockWatch bot once, so Telegram lets it message you.

---

## 4. Configure the environment

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from BotFather. Server-side only. |
| `ADMIN_CHAT_ID` | yes | Your numeric Telegram chat id. Support messages land here. |
| `ADMIN_TOKEN` | yes | Password for `/admin` and the admin API. Use 32+ random chars. |
| `SUPABASE_URL` | yes | Supabase project URL. |
| `SUPABASE_SERVICE_KEY` | yes | Supabase **service_role** key. Server-side only. |
| `PORT` | no | HTTP port, default `8080`. Hosts usually set this for you. |
| `ALLOWED_EXTENSION_ORIGIN` | no | Restrict `POST /api/notify` CORS to one origin, e.g. `chrome-extension://abcdefgh…`. Empty = any origin (that endpoint only). |
| `PUBLIC_URL` | no | Public base URL, used in startup logs. |

Generate a strong admin token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## 5. Run it

Development (auto-reload via `tsx`):

```bash
npm run dev
```

Production:

```bash
npm run build && npm start
```

Other scripts: `npm run typecheck` (no emit), `npm run clean`.

On a healthy boot you will see:

```
INFO  [stockwatch] authenticated with Telegram as @YourBot
INFO  [stockwatch] supabase reachable
INFO  [stockwatch] http listening on port 8080
INFO  [stockwatch] admin panel: http://localhost:8080/admin
INFO  [bot] bot started (long polling)
```

Then open <http://localhost:8080/admin> and sign in with `ADMIN_TOKEN`.

Verify the whole loop:

1. Message your bot `/start` → you get a link code.
2. `curl` an alert to yourself with that code (see below) → it arrives in Telegram.
3. Send the bot "something is broken" → it appears in your admin chat; reply to that
   forwarded message → your answer arrives back in the user's chat.

---

## Deploying (Railway / Render)

Long polling needs an **always-on process**, not a serverless function and not a service
that sleeps. Only ever run **one instance** — two instances polling the same bot token
fight over updates (Telegram returns `409 Conflict`).

### Railway

1. Push this repo to GitHub, then **New Project → Deploy from GitHub repo** on
   [railway.app](https://railway.app).
2. Railway detects Node. Confirm the commands under **Settings → Build/Deploy**:
   - Build: `npm ci && npm run build`
   - Start: `npm start`
3. **Variables** → add every variable from the table above. Railway injects `PORT`; leave
   it unset or set it to `8080` and expose that port.
4. **Settings → Networking → Generate Domain** to reach `/admin` from anywhere.
5. Keep the replica count at **1**.

### Render

1. **New → Web Service**, connect the repo. Runtime **Node**.
2. Build command: `npm ci && npm run build` — Start command: `npm start`.
3. Instance type: any **paid** tier. The free tier spins down when idle, which stops the
   bot; if you must use free, expect gaps in alert delivery.
4. Add the environment variables from the table above. Render sets `PORT` itself.
5. Health check path: `/health`.
6. Keep the instance count at **1**.

### Switching to webhooks later

The bot is created independently of its transport, so moving off long polling is a small
change in [`src/bot/index.ts`](src/bot/index.ts): replace the `bot.launch(...)` call in
`launch()` with an Express-mounted webhook, e.g.

```ts
app.use(await bot.createWebhook({ domain: config.publicUrl! }));
```

Everything else — handlers, reply routing, the notifier used by `POST /api/notify` —
stays as is.

---

## API reference

### `POST /api/notify`

The endpoint the extension calls. CORS is open on this route only (or restricted to
`ALLOWED_EXTENSION_ORIGIN`); every other route is same-origin.

```bash
curl -X POST http://localhost:8080/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"code":"K7QMZ4RT","title":"AAPL +5%","body":"Crossed $200 — target hit."}'
```

| Field | Type | Notes |
| --- | --- | --- |
| `code` | string | The user's link code from the bot. Case-insensitive. |
| `title` | string | Optional if `body` is present. Sent in bold. Max 200 chars. |
| `body` | string | Optional if `title` is present. Max 2000 chars. |

| Status | Meaning |
| --- | --- |
| `200` | Delivered and logged: `{"ok":true,"delivered":true}` |
| `400` | Missing/invalid `code`, or neither `title` nor `body` |
| `404` | No user has that link code |
| `410` | The user blocked the bot (they are marked `blocked`) |
| `429` | Rate limited — 20/minute and 200/hour per code; see `Retry-After` |
| `502` | Telegram rejected the send |
| `503` | Database unavailable |

### Admin endpoints

Authenticate with **either** an `X-Admin-Token: <ADMIN_TOKEN>` header (or
`Authorization: Bearer <ADMIN_TOKEN>`), **or** the `sw_admin` cookie that
`POST /api/admin/login` sets — that is what the panel's login form uses.

| Endpoint | Description |
| --- | --- |
| `POST /api/admin/login` | Body `{"token":"…"}`. Sets the session cookie (7 days, HttpOnly). |
| `POST /api/admin/logout` | Clears the cookie. |
| `GET /api/admin/session` | `200` if the current credentials are valid. |
| `GET /api/admin/users?limit=500` | Users with `joined_at`, `username`, `status`, `last_seen`, `message_count`, `notification_count`. |
| `GET /api/admin/messages?limit=100` | Recent messages, both directions, newest first, with the user attached. |
| `GET /api/admin/stats` | `users`, `activeUsers`, `blockedUsers`, `messagesToday`, `notificationsToday` (today = UTC day). |

```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8080/api/admin/stats
```

### Other routes

- `GET /admin` — the admin panel. It renders the login form until you authenticate; every
  piece of data behind it comes from the protected endpoints above.
- `GET /health` — `{"ok":true,"db":"up"}`, or `503` when Supabase is unreachable. Use it as
  your host's health check.

### Bot commands

| Command | Effect |
| --- | --- |
| `/start` | Registers the user (or refreshes them) and sends the link code. |
| `/code` | Re-sends the link code. |
| `/help` | Short usage text. |
| `/reply <chat_id> <message>` | **Admin chat only.** Answers a user without quoting a forwarded message. |

---

## How the extension uses this

1. The extension shows a "Connect Telegram" button linking to `https://t.me/<your_bot>`.
2. The user presses **Start**; the bot replies with an 8-character link code.
3. The user pastes that code into the extension's settings; the extension stores it.
4. To raise an alert, the extension `POST`s to `https://<your-deployment>/api/notify` with
   `{ code, title, body }`.

The link code is the per-user shared secret — it is the only credential the extension ever
holds. The bot token and the Supabase service key never leave this server and are never
included in any API response. A `404` from `/api/notify` means the stored code is stale
(the user can get a fresh one with `/code`); a `410` means they blocked the bot.

---

## Project layout

```
src/
  index.ts              startup, validation, graceful shutdown
  config.ts             env parsing with actionable error messages
  logger.ts             leveled logger
  db/
    client.ts           service-role Supabase client
    types.ts            typed schema (tables + admin view)
    repo.ts             every query in the app
  bot/
    index.ts            Telegraf handlers: /start, /code, /help, support chat
    notifier.ts         sends that never throw; marks blocked users
    reply-routing.ts    maps admin replies back to the right user
  api/
    server.ts           Express app, security headers, error handling
    notify.ts           POST /api/notify (+ CORS for the extension)
    admin.ts            admin JSON endpoints and cookie login
    auth.ts             constant-time token check
    rate-limit.ts       fixed-window limiter
  admin/
    panel.html          the admin panel (vanilla JS, no build step)
schema.sql              run this in the Supabase SQL editor
scripts/copy-assets.js  copies panel.html into dist/ during build
```

---

## Operating notes

- **Reply routing** is doubly robust: each forwarded message carries a `#sw<chat_id>`
  marker *and* is indexed in memory by its `message_id`. Replies keep working after a
  restart because the marker is parsed from the quoted text.
- **Blocked users**: when Telegram reports a chat as unreachable, the user's `status`
  becomes `blocked` and the panel shows it. Talking to the bot again flips them back to
  `active`.
- **Nothing crashes the process**: Telegram and database failures are caught, logged and
  turned into HTTP status codes or admin-chat notices. Unhandled rejections and uncaught
  exceptions are logged rather than fatal.
- **Startup is strict**: a missing/invalid env var, a token Telegram rejects, or a busy
  port stops the process immediately with a printed explanation and exit code 1 — no crash
  loop, no stack-trace spam.
- **Rate limiting** is in-memory and per link code (20/min, 200/hour), plus 10 login
  attempts per minute per IP.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `the Telegram bot token was rejected` | Wrong or revoked token. Copy a fresh one from BotFather into `TELEGRAM_BOT_TOKEN`. |
| `409 Conflict` in the logs | Two instances are polling the same bot. Scale to one replica and stop any local `npm run dev` that is still running. |
| `supabase is not reachable or the schema is missing` | `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` wrong, or `schema.sql` was never run. `/health` shows `db: down`. |
| Forwarded messages never arrive | `ADMIN_CHAT_ID` is wrong, or you never pressed **Start** on your own bot. |
| `/api/notify` returns `404` | The code is stale or mistyped; ask the user for `/code`. |
| `/api/notify` returns `410` | The user blocked the bot. |
| Admin panel keeps asking for the token | Cookies blocked, or `ADMIN_TOKEN` differs between what you type and the deployed env. |
| CORS error in the extension console | `ALLOWED_EXTENSION_ORIGIN` is set to a different origin than the extension's. Clear it or set the exact `chrome-extension://<id>` value. |
