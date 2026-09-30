# ClipSave

Russian Instagram/TikTok video downloader with a server-side SaveAPI integration.
Node.js 22+ is required; no npm dependencies are needed.

## Local setup

1. Create your account and key at https://saveapi.org/en/.
2. Put the key in the ignored `.env` file as `SAVEAPI_API_KEY=your_key`.
   `.env.example` lists the configuration for a fresh checkout.
3. Run `npm start` and open http://127.0.0.1:4173.
   Restart after changing `.env`. Change `PORT` if 4173 is occupied.

Never put the key in frontend code, Git, or chat. An empty key leaves direct
video links usable but social downloads return `API_NOT_CONFIGURED`.

## API

- `GET /api/health`: health and `socialReady`, without secrets.
- `POST /api/resolve`: JSON `{ "url": "https://...", "platform": "auto" }`.
  `platform` can also be `instagram` or `tiktok`.
  Returns `{ platform, title, media: [{ downloadUrl, ext, label, sizeMb }] }`.
- `GET /api/download?ticket=...`: streams a social video as an attachment.
  Tickets expire in 10 minutes. Changing the API key invalidates old tickets.

Social videos are resolved using the documented API at
https://saveapi.org/en/docs/. A real API key is needed to verify actual platform
availability. The automated tests use a mock provider, not live downloads.
SaveAPI may charge credits for requests; current quotas are in its dashboard.

Direct file links open at their source and may play in the browser rather than
download when the source does not set an attachment header. They are never
fetched by the backend. Social download requests only reach allowlisted CDN
hosts; redirects are rechecked, response types and sizes are checked, and no
platform login or private-account access is implemented.

Limits: 250 MiB per social video, 30 seconds for resolving, 120 seconds for
streaming, 20 videos per publication. Resolve limit is 10 requests per minute
per IP per process/Worker isolate. This is a small private-site safeguard, not
a global billing cap. Keep the existing private audience; add shared rate
limiting and a provider spending cap before opening the site to the public.

## Verification and deployment

Run `npm test` and `npm run build`. The build creates a self-contained
Cloudflare-compatible Worker at `.open-next/worker.js`. The local Node adapter
and hosted Worker use the same request handler.

The existing Sites project is recorded in `.openai/hosting.json`. Set
`SAVEAPI_API_KEY` as a secret in Sites runtime environment variables, then
deploy a saved version to apply it. Do not package `.env` or publish a new
project. The deployment archive contains `.openai/hosting.json` and
`.open-next/worker.js`; frontend assets are embedded in the Worker.
