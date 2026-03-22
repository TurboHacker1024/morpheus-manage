# Morpheus Manage Docker Handoff

This folder is safe to publish. It contains only generic Docker packaging and deployment examples for the `morpheus-manage` app. It does not include any live domains, tokens, passwords, or server-specific values.

## Included Files

- `Dockerfile`: production image for the app
- `.dockerignore`: keeps the build context clean
- `.env.example`: sample environment variables
- `docker-compose.example.yml`: example local/private deployment
- `.gitignore`: ignores local secrets and runtime data

## Quick Start

1. Copy `Dockerfile` and `.dockerignore` into the root of the `morpheus-manage` repository.
2. Copy `.env.example` to `.env` and fill in your own Synapse values.
3. Build the image:

```bash
docker build -t morpheus-manage .
```

4. Run it directly:

```bash
docker run --rm \
  -p 127.0.0.1:4173:4173 \
  --env-file .env \
  morpheus-manage
```

5. Open `http://localhost:4173`.

## Docker Compose

An example Compose file is included in `docker-compose.example.yml`.

It keeps the app private by binding to `127.0.0.1` only. If this is put behind a reverse proxy, add authentication in the proxy layer because the app itself does not provide a login screen.

## Recommended Runtime Adjustments

If the application code has not already been updated for containers, these changes are recommended:

- Listen on `0.0.0.0` instead of `localhost`
- Add a lightweight `/healthz` endpoint for health checks
- Support `SYNAPSE_ADMIN_TOKEN_FILE` in addition to `SYNAPSE_ADMIN_TOKEN` so Docker secrets can be used

## Security Notes

- Never commit a real admin token.
- Do not expose this UI directly to the public internet without an authentication layer in front of it.
- Prefer file-based secrets or Docker secrets over plain environment variables when possible.
- Keep the Synapse Admin API private.
