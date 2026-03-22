# Synapse Admin UI (local)

A lightweight local web UI for basic Synapse admin tasks: view users, create users, and deactivate users.

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

- This app proxies requests to the Synapse Admin API. The admin token never touches the browser.
- Keep the Admin API private and run this app on a trusted machine/network.
- Deactivation is non-destructive by default (`erase: false`).

## Environment variables

- `SYNAPSE_BASE_URL`: Base URL for your Synapse server (e.g., `https://malainia.com`).
- `SYNAPSE_ADMIN_TOKEN`: Admin access token (secret).
- `SYNAPSE_SERVER_NAME`: Homeserver name (e.g., `malainia.com`).
- `PORT`: Port for this UI (default `4173`).
