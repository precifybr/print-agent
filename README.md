# Print Assistant

Electron desktop local print bridge for browser-based systems.

## Local bridge

When the app starts, it opens a local HTTP server:

- `http://localhost:18181/status`
- `http://localhost:18181/printers`
- `http://localhost:18181/print`

The local mode does not require Supabase auth, JWT, bootstrap, polling, remote queue, or token rotation.

### API

`GET /status`

Returns app version, server state, default printer, detected printers, aliases, paper size, last print status, last error, and update status.

`GET /printers`

Returns detected Windows printers, the default printer, alias mapping, preferred printer, local routes, and selected paper size.

`POST /print`

Prints immediately.

```json
{
  "printer": "BALCAO",
  "html": "<html><body>Pedido #123</body></html>"
}
```

```json
{
  "printer": "BALCAO",
  "text": "Pedido #123"
}
```

Route-based print:

```json
{
  "route": "kitchen",
  "text": "Pedido #123"
}
```

Printer resolution order:

- exact Windows printer name
- configured alias
- partial printer name match
- preferred printer
- default Windows printer fallback

Paper size can be configured in the Electron UI as `58mm`, `80mm`, or `A4`.

### Frontend handling

Use a short browser timeout, usually 3-8 seconds. A successful `/print` response means the local bridge accepted the job and dispatched it to the hidden print worker.

Success:

```json
{
  "success": true,
  "accepted": true,
  "jobId": "uuid",
  "printer": "POS-58",
  "requestedPrinter": "BALCAO",
  "resolvedBy": "alias",
  "paperSize": "58mm"
}
```

Common errors:

```json
{ "success": false, "error": "INVALID_JSON" }
```

```json
{ "success": false, "error": "PAYLOAD_TOO_LARGE" }
```

```json
{ "success": false, "error": "DUPLICATE_PRINT_REQUEST" }
```

```json
{ "success": false, "error": "NO_PRINTER_AVAILABLE" }
```

If `GET /status` fails, show the operator that Print Assistant is offline and ask them to open the desktop app. Do not fall back to cloud polling for local printing.

### Production notes

- The server binds to `127.0.0.1:18181` and rejects non-loopback requests.
- Print payloads are capped at 2 MB.
- Duplicate prints with the same content/printer within a short window are rejected.
- Logs are written under the app user data directory and avoid storing full HTML content.
- Auto-update is prepared with `electron-updater` and GitHub Releases provider `precifybr/print-agent`, but update checks are opt-in until production rollout.

## Repository contents

- Electron app source: `main.js`, `preload.js`, `index.html`
- Windows packaging assets: `build/`
- Build and release notes: `docs/BUILD.md`
- Legacy cloud print network contract and Supabase backend pieces: `docs/PRINT_NETWORK.md`, `supabase/`

## Local development

Requirements:

- Node.js
- npm
- Windows with access to the target printers

Commands:

- `npm start`
- `npm run pack`
- `npm run dist:win`

The generated Windows installer is written to `dist/`.

## Distribution notes

- `node_modules/`, logs, caches, and local runtime data stay out of version control.
- Release artifacts are distributed through GitHub Releases rather than committed into the repository.
- Code signing material and secrets must never be committed.

## License

Apache License 2.0. See `LICENSE`.
