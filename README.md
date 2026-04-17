# Morpheus Manage (local)

Local web admin UI for Synapse with focused workflows for users, rooms, media operations, and audit review.

## Setup

1. Install Node.js 18+.
2. Copy `.env.example` to `.env` and fill in your admin token and server details.
3. Install dependencies:

```
npm install
```

4. Start the server:

```
npm start
```

Then open `http://localhost:4173` in your browser.

## Notes

- This app proxies requests to the Synapse Admin API; the admin token stays on the server side.
- Keep Synapse Admin API access private and run this tool only on trusted hosts/networks.
- Destructive actions require confirmation in the UI.

## Current feature areas

- Users: directory, create user, lock/reactivate/deactivate flows, session review/revoke, profile management.
- Rooms: room list/search/sort, member views, room moderation actions.
- Media:
  - Storage dashboard (`/_synapse/admin/v1/statistics/users/media`)
  - Per-user media browser (`/_synapse/admin/v1/users/<user_id>/media`)
  - Per-room media inventory (`/_synapse/admin/v1/room/<room_id>/media` + media metadata)
  - Reported content queue moderation (`/_synapse/admin/v1/event_reports`)

## Page map

- Home
  - System status: `/index.html`
  - Recent actions: `/actions.html`
- Users
  - Directory: `/users.html`
  - Activity and audits: `/audits.html`
  - User activity detail: `/user.html?user_id=@user:server`
- Rooms
  - All rooms: `/rooms.html`
  - Room moderation: `/room.html?room_id=!room:server`
- Media
  - Storage dashboard: `/media-storage.html`
  - Per-user media browser: `/media-users.html`
  - Per-room media inventory: `/media-rooms.html`
  - Reported content moderation: `/media-reports.html`

## Environment variables

- `SYNAPSE_BASE_URL`: Base URL for your Synapse server (e.g., `https://malainia.com`).
- `SYNAPSE_ADMIN_TOKEN`: Admin access token (secret).
- `SYNAPSE_SERVER_NAME`: Homeserver name (e.g., `malainia.com`).
- `PORT`: Port for this UI (default `4173`).
- `ACTION_LOG_MAX_ENTRIES` (optional): Max retained local action feed entries (default `5000`).
- `JSON_BODY_LIMIT` (optional): JSON request size limit, e.g. `12mb`.
- `MAX_AVATAR_UPLOAD_BYTES` (optional): Max avatar upload size in bytes (default `5242880`).
- `MEDIA_QUERY_MAX_LIMIT` (optional): Max media/report query page size allowed by this UI (default `500`).
