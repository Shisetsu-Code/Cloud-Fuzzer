# Cloud-Fuzzer

Fast, persistent screenshot classification for [Fuzzer-Manual](https://github.com/Shisetsu-Code/Fuzzer-Manual). **No game analysis or clicks are performed by the server.**

**Both components are in this repository:**

1. `src/` — Cloudflare Worker REST API + built-in **remote MCP** at `/mcp`, backed by **R2** (private JPEG files) and **D1** (queue, normalized marks, revisions and history).
2. `mcp/stdio.mjs` — **local MCP** for Codex or other clients that require stdio, forwarding to the same Cloudflare Worker.

`uploader/upload.mjs` transfers existing Fuzzer-Manual screenshots from Windows without repeating game captures.

## Deploy (one-time, on your own Cloudflare account)

Install Node.js 22+, then from this repository:

```powershell
npm install
npx wrangler login
npx wrangler r2 bucket create cloud-fuzzer-images
npx wrangler d1 create cloud-fuzzer
```

Copy the returned D1 database UUID into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

```powershell
npx wrangler d1 migrations apply cloud-fuzzer --remote
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put REVIEW_TOKEN
npx wrangler secret put MCP_TOKEN
npx wrangler deploy
```

Use **three different cryptographically random secrets** (at least 32 random bytes each). Wrangler reads them interactively; never commit, paste into a chat, or publish them. No Cloudflare credentials are required by MCP clients: they use only your limited `MCP_TOKEN`. Worker authentication requires `Authorization: Bearer <token>` and uses separate ingest, reviewer, and MCP scopes. R2 bucket remains **private**.

Health check (no credentials):

```powershell
curl.exe https://cloud-fuzzer.YOUR_SUBDOMAIN.workers.dev/health
```

Do not claim the deployment is active until this URL returns `{"ok":true,...}`.

## Upload your already captured screenshots

On your PC, while Fuzzer-Manual continues capturing with a maximum of 3 game starts/minute:

```powershell
$env:CLOUD_FUZZER_URL = 'https://cloud-fuzzer.YOUR_SUBDOMAIN.workers.dev'
$env:CLOUD_FUZZER_INGEST_TOKEN = '<INGEST_TOKEN>'
node .\uploader\upload.mjs --source="$HOME\Fuzzer-Manual\data\catalog-exports\pragmatic-20261019" --watch
```

Run this from the `Cloud-Fuzzer` folder (or use the absolute path to `uploader/upload.mjs`).

- `--watch` rechecks `manifest.json` every 12 seconds; `--interval-ms=15000` changes it.
- Each JPEG is SHA-256 verified, deduplicated in D1, and stored by hash in R2.
- `.cloud-upload-state.json` in your local catalog directory remembers completed uploads.
- This **does not open a browser, perform a spin or buy**, or touch the capture speed limit.
- `--dry-run` validates available files without uploading.
- Captures marked `review` (stuck in INTRO) are also uploaded, so the assistant can identify a navigation point rather than lose them.
- Keep the uploader running separately from the collector.

Do **not** confuse R2 with D1: storing binary JPEGs in D1 is inefficient. D1 is the authoritative database for queue state and classifications, and it references images in R2.

## MCP — classify with two calls, no GitHub commits

**Remote MCP:** `https://cloud-fuzzer.YOUR_SUBDOMAIN.workers.dev/mcp` with an `Authorization: Bearer <MCP_TOKEN>` header. Use a client that supports stateless Streamable HTTP and bearer headers.

**Local MCP/stdio:** configure `mcp/config.example.json` with the Worker URL and token in your MCP client, or:

```powershell
$env:CLOUD_FUZZER_URL = 'https://cloud-fuzzer.YOUR_SUBDOMAIN.workers.dev'
$env:CLOUD_FUZZER_MCP_TOKEN = '<MCP_TOKEN>'
node .\mcp\stdio.mjs
```

Tools:

| Tool | What it does |
|---|---|
| `next_capture` | Claims a pending image and returns the **JPEG as image content** and `{id, leaseId, revision, imageSha256}`. |
| `save_classification` | Stores all normalized marks **atomically on that capture** and moves to next. |
| `release_capture` | Returns an unfinished capture to the queue. |
| `get_capture` | Reloads the image if its lease is still valid. |
| `queue_stats` | Fast counters: pending / leased / classified / needs_review. |

Leases expire after 3 minutes by default (configure 30–900 seconds in `next_capture`). A stale worker cannot overwrite another classifier or a newer screenshot: writes compare **lease ID, revision and SHA-256**.

Example marks:

```json
{
  "status": "classified",
  "reviewer": "gpt",
  "marks": [
    {"x": 0.12, "y": 0.34, "kind": "buy", "label": "BUY FREE SPINS"},
    {"x": 0.12, "y": 0.58, "kind": "navigate", "label": "Special Bets"}
  ]
}
```

Include the `id`, `leaseId`, `revision`, and `imageSha256` returned by `next_capture`. For a screen with no relevant actions use `marks: []`. For an intro or uncertain image use `status: "needs_review"`. Do **not** mark a game as having no purchases merely because none are visible on the current screenshot.

### Reviewer prompt for another chat

> Use Cloud-Fuzzer MCP. Call `next_capture`, open the JPEG, mark all relevant buy/menu/pick/ante buttons with 0–1 coordinates, call `save_classification` once, then immediately call `next_capture` again. No rules, HAR, payloads, purchases or essays. After each image report only: **slug: N points, saved, X seconds**. If uncertain save `needs_review` or release. Never claim success until the MCP confirms it.

MCP is **not automatically connected to this ChatGPT conversation** just because its code exists in GitHub. The Worker must be deployed and the client connected by its owner first.

## REST API

All endpoints except `/health` require a bearer token with the appropriate scope.

| Request | Required token | Behavior |
|---|---|---|
| `POST /v1/captures` (multipart `image`, `metadata`) | INGEST | Adds JPEG to R2 and pending capture to D1; identical uploads are idempotent. |
| `POST /v1/claim` | REVIEW | Claims next pending/stale lease; `runId` optional. |
| `POST /v1/classify` | REVIEW | Stores marks with lease, revision and hash CAS. |
| `POST /v1/release` | REVIEW | Releases unfinished lease. |
| `GET /v1/stats?runId=...` | REVIEW | Queue counters. |
| `GET /v1/captures/:id` | REVIEW | Read metadata, marks and status. |
| `GET /v1/captures/:id/image` | REVIEW | Read private image. |
| `POST /mcp` | MCP | Stateless JSON-RPC 2.0 MCP Streamable HTTP. |

Explicitly replacing an image under the same `{runId,slug,taskId}` requires multipart `replace=true` from the ingest role. That increments revision, clears old marks and returns it to pending. History of previous classifications is retained in `classification_history`.

## Run tests without a Cloudflare account

```powershell
npm run check
npm test
```

Tests use in-memory SQLite to validate the actual D1 SQL, and a fake R2 binding to exercise the Worker + MCP HTTP entrypoints. Deployment, live R2/D1 bindings, and client authentication require the user's Cloudflare account and were **not** performed by CI.

## Scope and limitations

- This project is a transport and classification store, **not** a slot-game automation engine.
- No real-money operations, cookies, casino accounts, or credential harvesting.
- The existing Fuzzer-Manual collector can keep publishing on GitHub independently; the new uploader copies its local screenshots to Cloudflare as a separate queue.
- After classification, results are persistent in D1. Consuming them into Fuzzer-Manual's local execution tree will need a downstream adapter, not part of this initial storage/MCP service.
