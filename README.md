# Telegram Credit Bot (Cloudflare Workers)

A **serverless Telegram bot** for managing user credits (top‑ups, balances, history) with **admin approval workflows**, running on **Cloudflare Workers**. Storage is pluggable: use **KV** for quick start, or **D1** for relational history.

> One‑line description (for GitHub):  
> _Serverless Telegram bot for credit management: top-ups, balances, history, and admin workflows via Cloudflare Workers._

---

## ✨ Features
- **User commands**: `/start`, `/topup <amount>`, `/balance`, `/history`
- **Admin commands**: `/approve <requestId>` — approve a pending top‑up; `/reject <requestId>` — reject a pending top‑up
- **Admin tools**: `/set <userId> <balance>`, `/export` (CSV) for auditing
- **Moderation flow**: users submit top-up requests → admins approve/reject → balances update
- **Storage options**:
  - **KV** (default): balances + simple request tracking
  - **D1** (optional): normalized tables for audit logs + exports
- **Secure webhook** endpoint with a secret path segment
- **Works in groups or DM** (admin group recommended)

---

## 🧱 Tech Stack
- **Cloudflare Workers** (JavaScript/TypeScript)
- **Telegram Bot API** (webhook mode)
- **Cloudflare KV** (required) & **D1** (optional)
- **Wrangler** CLI for dev & deploy

---

## 🗺️ High‑Level Flow
```
User -> Telegram -> Webhook (Worker) -> Storage (KV/D1) -> Admin Notifications -> Approvals -> Balance Update
```

---

## 📁 Suggested Repo Structure
```
credit-bot/
├─ src/
│  ├─ index.ts             # Worker entry
│  ├─ telegram.ts          # Telegram API helpers (sendMessage, answerCallbackQuery, etc.)
│  ├─ commands/
│  │  ├─ user.ts           # /start /topup /balance /history
│  │  └─ admin.ts          # /approve /reject /set /export
│  ├─ storage/
│  │  ├─ kv.ts             # KV implementation
│  │  └─ d1.ts             # D1 implementation
│  └─ utils.ts             # parsing, formatting, validation
├─ wrangler.toml
├─ package.json
└─ README.md
```

---

## ⚙️ Configuration
Set these as **secrets** or **env vars** in `wrangler.toml`.

### Required
- `TELEGRAM_BOT_TOKEN` — Your BotFather token
- `WEBHOOK_SECRET` — A random string used in the webhook path
- `ADMIN_CHAT_IDS` — Comma-separated Telegram chat IDs that can approve (e.g. `12345,67890`)
- KV binding: `CREDIT_KV`

### Optional
- `BOT_BASE_URL` — Public HTTPS URL for the worker (used to set the webhook)
- D1 binding: `CREDIT_DB` (if you want relational audit logs)

### Example `wrangler.toml`
```toml
name = "credit-bot"
main = "src/index.ts"
compatibility_date = "2024-12-01"

# KV binding
[[kv_namespaces]]
binding = "CREDIT_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" # fill after 'wrangler kv:namespace create'

# D1 binding (optional)
[[d1_databases]]
binding = "CREDIT_DB"
database_name = "credit_bot_db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[vars]
ADMIN_CHAT_IDS = "123456789,987654321"
# BOT_BASE_URL can be set here or via secrets

# Secrets (set via CLI; do NOT hardcode)
# TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET
```

Set secrets:
```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put WEBHOOK_SECRET
```

Create KV namespace:
```bash
wrangler kv:namespace create CREDIT_KV
# copy the id into wrangler.toml
```

Create D1 (optional):
```bash
wrangler d1 create credit_bot_db
# copy the database_id into wrangler.toml
```

---

## 🧪 Local Dev
```bash
# install deps
npm i

# run locally
wrangler dev --local
# or with remote dev (recommended)
wrangler dev
```

By default your webhook will be:  
`https://<your-worker-subdomain>/<WEBHOOK_SECRET>/telegram`

---

## 🔗 Set Telegram Webhook
Replace placeholders and run:
```bash
# using curl
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-worker-subdomain>/<WEBHOOK_SECRET>/telegram",
    "allowed_updates": ["message","callback_query","chat_member"]
  }'
```

Check status:
```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Remove webhook (switch to polling for tests):
```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook?drop_pending_updates=true"
```

---

## 🧰 Commands (Default Set)
### Users
- `/start` — show help & your current balance
- `/topup <amount>` — create a top‑up request (e.g. `/topup 100`)
- `/balance` — show your current balance
- `/history` — last N transactions (KV or D1)

### Admins
- `/approve <requestId>` — approve a pending top‑up
- `/reject <requestId>` — reject a pending top‑up
- `/set <userId> <balance>` — force set a user balance
- `/export` — export transactions as CSV (D1 recommended)

> Tip: Put all admin users in a dedicated **admin group** and forward new requests there.

---

## 🗃️ Data Model
### KV (default)
- `user:<telegramId>:balance` → number (as string)
- `req:<requestId>` → JSON `{ id, userId, amount, status, createdAt }`
- `hist:<telegramId>:<ts>` → JSON transaction record
- `meta:requestCounter` → monotonic counter

### D1 (optional schema)
```sql
CREATE TABLE users (
  telegram_id TEXT PRIMARY KEY,
  balance REAL NOT NULL DEFAULT 0
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,           -- "topup" | "debit" | "adjust"
  status TEXT NOT NULL,         -- "pending" | "approved" | "rejected"
  note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);
```

---

## 🔒 Security Notes
- Use **`/<WEBHOOK_SECRET>/telegram`** path and **reject** any request not matching it.
- Validate incoming updates’ **method and content type**.
- Keep `TELEGRAM_BOT_TOKEN` as a **Wrangler secret** (never commit).
- Consider **rate limiting** (per IP or per user) for `/topup`.
- For admin commands, **hard‑check chat IDs** against `ADMIN_CHAT_IDS`.

---

## 🚀 Deploy
```bash
wrangler login        # first time
wrangler publish
```

After publish, re‑run **Set Telegram Webhook** with the production URL.

---

## 🧭 Minimal Worker Entry (TypeScript)
```ts
// src/index.ts
export interface Env {
  CREDIT_KV: KVNamespace;
  CREDIT_DB?: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_CHAT_IDS: string; // "123,456"
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Only accept POST to "/<secret>/telegram"
    if (req.method !== "POST" ||
        url.pathname !== `/${env.WEBHOOK_SECRET}/telegram`) {
      return new Response("Not found", { status: 404 });
    }

    const update = await req.json().catch(() => null);
    if (!update) return new Response("Bad Request", { status: 400 });

    // TODO: parse message text & dispatch to commands
    // Example: reply "pong" to /ping
    const chatId = update.message?.chat?.id;
    const text = (update.message?.text ?? "").trim();

    if (chatId && text === "/ping") {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "pong" }),
      });
    }

    return new Response("OK");
  }
};
```

---

## 🧰 Troubleshooting
- **Webhook not receiving updates**: re‑set `setWebhook` with the correct public URL & secret path; check `getWebhookInfo`.
- **403 from Telegram**: wrong bot token or blocked by privacy mode.
- **KV writes not persisting locally**: prefer remote dev (`wrangler dev`) to test KV/D1 bindings.
- **Admins can’t approve**: verify their chat IDs are included in `ADMIN_CHAT_IDS` and parsed correctly.
- **Unicode in CSV export**: set `Content-Type: text/csv; charset=utf-8` and prefix `\ufeff` for Excel.

---

## 📜 License
MIT (or your preference)
