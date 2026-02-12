# ecto-server

Self-hostable community server for the Ecto federated chat platform.

## Specs
All implementations follow specs in `ecto-docs`:
- API routes: `ecto-docs/docs/technical/api-reference/server-api/`
- WS events: `ecto-docs/docs/technical/api-reference/websocket-events/main-ws.md`
- DB schema: `ecto-docs/docs/technical/database-schema/server-tables.md`
- Permissions: `ecto-docs/docs/features/servers-and-channels.md`
- Voice: `ecto-docs/docs/features/voice-video/`

## Architecture
- tRPC over HTTP for stateless API
- Raw WebSocket (ws) for real-time events
- mediasoup SFU for voice/video
- Drizzle ORM with PostgreSQL or SQLite
