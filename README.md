# <img src="ecto.png" alt="ecto" height="32"> ecto-server

A self-hostable community server for [Ecto](https://ecto.chat) - the federated chat platform where users own their servers. Deploy with Docker or run standalone, connect from any Ecto client.

<img src="https://img.shields.io/badge/AI--Assisted_Development_Disclosure-Claude_(Anthropic)-8A2BE2?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PHBhdGggZD0iTTEyIDJhMTAgMTAgMCAxIDAgMCAyMCAxMCAxMCAwIDAgMCAwLTIwem0wIDE4YTggOCAwIDEgMSAwLTE2IDggOCAwIDAgMSAwIDE2eiIvPjwvc3ZnPg==" alt="AI-Assisted Development" />

> [!NOTE]
> This project uses **Claude** (Anthropic) as a development tool. Responsible AI-assisted development means every generated contribution is reviewed, tested, and validated by the project team before merging. AI accelerates development, it does not replace engineering judgment, code review, or security auditing.
>
> **Security & privacy measures protecting end users:**
>
> - **JWT Authentication** - HS256-signed tokens with 2-hour expiry; token version field enables instant revocation of all sessions for a user
> - **Permission System** - Bitfield-based permissions with role hierarchy enforcement, per-channel and per-category overrides, and batch-optimized resolution
> - **Input Validation** - Zod schemas on every tRPC procedure and WebSocket message; invalid payloads are rejected before reaching business logic
> - **File Upload Security** - Content-type enforcement, per-file size limits (5MB messages, 2MB icons, 800KB banners), storage quota tracking, and early body-size rejection to prevent memory exhaustion
> - **Rate Limiting** - Token-bucket algorithm with per-key limits and automatic stale-entry cleanup
> - **Password Hashing** - Argon2id for local accounts; no plaintext passwords are ever stored
> - **Audit Logging** - Every administrative action (kicks, bans, role changes, channel edits) logged with actor, target, and timestamp
> - **WebSocket Handshake Security** - 10-second identify deadline, protocol version validation, 90-second heartbeat timeout, and event buffering with sequence numbers for reconnect recovery

---

## Features

### Chat & Messaging
- Text channels with message creation, editing, deletion, and pinning
- Emoji reactions and mention parsing (`@user`, `@role`, `#channel`, `@everyone`)
- File attachments with configurable size limits
- Per-channel slowmode
- Full-text message search
- Webhook integrations for external services

### Voice & Video
- Voice channels with up to 25 participants
- mediasoup SFU - Opus audio (48kHz), VP9/VP8/H264 video
- Screen sharing via producer abstraction
- Adaptive bitrate with spatial/temporal layer selection
- Voice state management (mute, deafen, video toggle)

### Server Management
- Roles with bitfield permissions and hierarchy enforcement
- Per-channel and per-category permission overrides
- Member management: kick, ban, role assignment
- Invite codes with optional expiry and usage limits
- Categories for channel organization
- Server pages (wiki-like rich content)
- Shared file hub with folder structure and access control
- Audit log for all administrative actions

### Real-Time
- Main WebSocket for channel events (messages, typing, voice signaling)
- Notification WebSocket for out-of-channel alerts
- Presence tracking (online, idle, custom status)
- Event buffering with sequence numbers for seamless reconnection
- 15-second grace period before broadcasting disconnect

### Authentication
- Dual identity: global (ecto-central) + local (username/password) accounts
- Argon2id password hashing for local accounts
- Central token verification with 5-minute cache
- Token version field for instant session revocation
- Self-hosted mode (full features) and managed mode (behind ecto-gateway)

### Server DMs
- Within-server direct messages between members
- Separate from cross-server DMs (those route through ecto-central)
- Read state tracking per conversation

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   HTTP Server (Node.js)              │
│  ┌─────────────┐   ┌──────────┐  ┌────────────────┐  │
│  │  tRPC API   │   │  File    │  │  WebSocket     │  │
│  │  (18 routes)│   │  Routes  │  │  /ws  /notify  │  │
│  └──────┬──────┘   └────┬─────┘  └───────┬────────┘  │
│         └───────────────┼────────────────┘           │
│                         ▼                            │
│  ┌───────────────────────────────────────────────┐   │
│  │              Middleware Layer                 │   │
│  │  Auth (JWT) · Permissions · Rate Limiting     │   │
│  └──────────────────────┬────────────────────────┘   │
│                         ▼                            │
│  ┌────────────┬─────────────────┬────────────────┐   │
│  │  Drizzle   │  Event          │  Voice Manager │   │
│  │  ORM (DB)  │  Dispatcher     │  (mediasoup)   │   │
│  └────────────┴─────────────────┴────────────────┘   │
│  ┌────────────┬─────────────────┬────────────────┐   │
│  │  Presence  │  Voice State    │  File Storage  │   │
│  │  Manager   │  Manager        │  (local/S3)    │   │
│  └────────────┴─────────────────┴────────────────┘   │
└──────────────────────────────────────────────────────┘
```

**Request Flow** - HTTP requests go through tRPC with context injection (auth user, database, server ID). WebSocket connections authenticate via `system.identify` within 10 seconds or get closed.

**Service Injection** - All major services (presence, voice state, rate limiter, file storage, event dispatcher) are pluggable singletons. Self-hosted mode uses in-memory implementations; managed mode swaps in Redis-backed versions.

**Database** - PostgreSQL via Drizzle ORM with type-safe queries and automatic migrations.

**Hosting Modes** - `self-hosted` runs as a standalone server with everything built in. `managed` runs behind ecto-gateway with shared PostgreSQL, S3 storage, and central auth.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 (ESM) |
| Language | TypeScript 5.9 (strict) |
| API | tRPC 11 (HTTP) |
| WebSocket | raw `ws` |
| Media | mediasoup 3.19 (WebRTC SFU) |
| ORM | Drizzle ORM 0.45 |
| Database | PostgreSQL 16 |
| Auth | jose (JWT), argon2 (passwords) |
| Validation | Zod |
| Package Manager | pnpm |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP + WebSocket server port |
| `DATABASE_URL` | - | PostgreSQL connection string |
| `JWT_SECRET` | **required** | Secret for signing server JWTs (32+ chars in production) |
| `CENTRAL_URL` | `https://api.ecto.chat` | ecto-central URL for global auth verification |
| `CLIENT_URL` | `https://app.ecto.chat` | Redirect for browsers visiting the server URL |
| `SERVER_ADDRESS` | auto-detected | Public IP/domain announced to WebRTC clients |
| `MEDIASOUP_MIN_PORT` | `40000` | Start of WebRTC transport port range |
| `MEDIASOUP_MAX_PORT` | `40100` | End of WebRTC transport port range |
| `UPLOAD_DIR` | `./data/uploads` | File upload storage directory |
| `HOSTING_MODE` | `self-hosted` | `self-hosted` (standalone) or `managed` (behind gateway) |
| `ALLOW_LOCAL_ACCOUNTS` | `true` | Enable username/password registration |
| `STORAGE_QUOTA_BYTES` | `0` (unlimited) | Per-server upload quota (images exempt) |
| `MAX_UPLOAD_SIZE_BYTES` | `0` (5MB default) | Per-file upload size limit |

---

## Setup

### Standalone

```bash
cp .env.example .env    # Edit JWT_SECRET and DATABASE_URL
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

### Docker

```bash
docker compose up
```

Requires **Node.js 22+** for standalone. Docker handles all dependencies including PostgreSQL and mediasoup native builds.

---

## API Overview

### tRPC Routes (18 routers, ~100+ procedures)

| Router | Key Operations |
|---|---|
| `server` | info, update, join, leave |
| `channels` | list, create, update, delete, reorder |
| `categories` | list, create, update, delete, reorder |
| `messages` | list, send, edit, delete, pin, reactions, search |
| `members` | list, kick, ban, add/remove roles |
| `roles` | list, create, update, delete, reorder |
| `invites` | list, create, delete, validate |
| `files` | list, delete |
| `readState` | list, update, clear |
| `serverDms` | conversations, history, send |
| `pages` | get, update, revisions |
| `hubFiles` | list, create, delete |
| `webhooks` | list, create, delete |
| `search` | full-text message search |
| `auditlog` | filtered admin action history |
| `serverConfig` | get/update server settings |
| `activity` | recent activity feed |

### WebSocket Events

**Main WS** (`/ws`) - Channel subscribe/unsubscribe, message CRUD, typing indicators, voice signaling (join, leave, produce, consume, connect), presence updates, member changes.

**Notify WS** (`/notify`) - Out-of-channel notifications for background servers.

---

## Project Structure

```
src/
├── index.ts             # Entry point: init DB, services, start HTTP
├── config/              # Environment validation (Zod schema)
├── middleware/           # Auth (JWT), permissions (bitfield), rate limiting
├── http/                # HTTP server, file upload/serve routes, webhooks
├── trpc/                # tRPC setup, context, 18 routers
├── ws/                  # WebSocket servers (main, notify), event dispatcher, handlers
├── db/                  # Drizzle ORM setup, PostgreSQL driver, 27 table schemas
├── services/            # Pluggable services (presence, voice state, storage, central client)
├── voice/               # mediasoup SFU wrapper
└── utils/               # JWT, errors, permissions, audit log, message helpers
```
