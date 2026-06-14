# Delegate to Human

An MCP server that gives agentic harnesses a human-delegation tool. Agents discover
registered humans, delegate asynchronous tasks, answer clarification questions, and
accept or request revisions to submitted results.

Humans receive and answer work through:

- **Web:** authenticated inbox with threaded messages, result submission, and files.
- **Email:** assignment notification with a one-time secure web link.
- **Telegram:** bot notifications and `/question`, `/message`, and `/result` replies.

## Architecture

The service is harness-neutral. It exposes seven MCP tools over Streamable HTTP:

| Tool | Purpose |
| --- | --- |
| `list_humans` | Discover active humans, skills, availability, and channels |
| `delegate_to_human` | Create an asynchronous task for a specific human |
| `get_human_task` | Read task status, thread, result, and attachment links |
| `list_human_tasks` | List tasks created by the current agent API key |
| `message_human` | Answer questions or add task context |
| `review_human_result` | Accept a result or request revision |
| `cancel_human_task` | Cancel unfinished work |

The task lifecycle is:

```text
pending_delivery -> awaiting_human
awaiting_human -> awaiting_agent -> awaiting_human
awaiting_human -> awaiting_agent_review -> completed
awaiting_agent_review -> awaiting_human  (revision requested)
```

`declined`, `expired`, `canceled`, and `delivery_failed` are terminal states.

## Local setup

Requirements: Node.js 24+, pnpm 11+, and SQLite-compatible native build support.

```bash
pnpm install
cp .env.example .env
```

Generate secrets and place them in `.env`:

```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -hex 32      # TOKEN_SECRET
openssl rand -hex 32      # ADMIN_TOKEN
```

Build and run:

```bash
pnpm build
pnpm start
```

> **Note:** static assets are content-hashed and enumerated at server start.
> Always rebuild *before* starting (or restart after a rebuild) — rebuilding
> the web bundle under an already-running server serves stale assets.

Open:

- Human inbox: `http://localhost:3000/`
- Admin console: `http://localhost:3000/admin`
- MCP endpoint: `http://localhost:3000/mcp`
- Health check: `http://localhost:3000/health`

The admin console uses `ADMIN_TOKEN`. Create at least one human profile and one API
key there. The raw API key is shown once.

For development, run the API and Vite dev server together:

```bash
pnpm dev
```

The UI is then at `http://localhost:5173`; `/api` requests are proxied to port 3000.

## MCP client configuration

Configure any Streamable HTTP MCP client with:

```json
{
  "url": "http://localhost:3000/mcp",
  "headers": {
    "Authorization": "Bearer dth_REPLACE_WITH_ISSUED_KEY"
  }
}
```

For harnesses that only launch local stdio MCP servers, use an HTTP-to-MCP bridge
and pass the same URL and authorization header. The service itself intentionally
does not depend on a particular agent harness.

The intended agent flow is:

1. Call `list_humans`.
2. Call `delegate_to_human` with an explicit `human_id`.
3. Continue other work and periodically call `get_human_task`.
4. When the task is `awaiting_agent`, use `message_human`.
5. When it is `awaiting_agent_review`, call `review_human_result`.

## Channel configuration

Channel credentials are encrypted at rest with AES-256-GCM using `ENCRYPTION_KEY`.
Each human has an ordered preference list. If a preferred channel fails, delivery
falls back to the next configured channel. An explicit `channel` in
`delegate_to_human` is strict and does not fall back.

### Email

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and optional authentication values in
`.env`. Email is outbound-only; recipients answer through the secure web link.

### Telegram

Set:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
```

Register the webhook after the service is publicly reachable:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d "{
    \"url\": \"https://YOUR_HOST/api/telegram/webhook\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"
  }"
```

Add the recipient's numeric Telegram chat ID to their admin profile. The bot accepts:

```text
/question TASK_UUID clarification needed
/message TASK_UUID progress update
/result TASK_UUID final result
```

Files are uploaded and downloaded through signed web links rather than native email
or Telegram attachments.

## Docker

```bash
cp .env.example .env
# Fill in required secrets.
docker compose up --build
```

SQLite and attachments persist under `./data`, mounted at `/app/data`.

## Security model

- Agent API keys are stored only as SHA-256 hashes and can be revoked.
- Human web sessions use signed, HTTP-only cookies.
- Email and generated admin login links are one-time and expire.
- Attachment URLs are task-scoped and expire.
- Telegram webhook updates are deduplicated and bound to configured chat IDs.
- Channel credentials use authenticated encryption at rest.
- Task data is isolated by the API key that created it and the assigned human.

Run verification with:

```bash
pnpm typecheck
pnpm test
pnpm build
```
