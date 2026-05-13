# Print Assistant

Desktop local-first print bridge for Windows stores.

## What It Does

Print Assistant runs only on the local computer and is responsible for:

- localhost bridge
- printer discovery
- sector routing
- local spool and queue
- printing
- local logs
- automatic updates

The app does not require token, polling, cloud auth, remote queue, or session state to print.

## Local Endpoints

When the app starts, it exposes:

- `GET http://127.0.0.1:18181/status`
- `GET http://127.0.0.1:18181/health`
- `GET http://127.0.0.1:18181/printers`
- `POST http://127.0.0.1:18181/print`
- `POST http://127.0.0.1:18181/print-test`

All endpoints are localhost-only.

## Printing Contract

The frontend can send a sector and an order payload:

```json
{
  "setor": "cozinha",
  "pedido": {
    "numero": 123,
    "itens": [
      "X-Burger",
      "Refrigerante"
    ]
  }
}
```

It can also send direct HTML or text:

```json
{
  "printer": "HPRT MPT-II",
  "html": "<html><body>Pedido #123</body></html>"
}
```

```json
{
  "printer": "HPRT MPT-II",
  "text": "Pedido #123"
}
```

Sector routing is local and automatic. The app tries sector-specific matches first, then preferred/default Windows printers.

## UI

The desktop UI is intentionally minimal:

- online/offline status
- detected printers
- quick test button
- update check
- quit

## Stability Notes

- Thermal printers `58mm` and `80mm` use the native dialog by default.
- A4 can try silent printing first and fall back to the dialog.
- Print jobs are serialized through a local queue.
- The app is single-instance and focuses the existing window.
- A watchdog recreates the localhost server if it stops listening.
- Logs rotate automatically at 5 MB.

Log files:

- `logs/app.log`
- `logs/print.log`
- `logs/localhost.log`

## Installer

Windows releases must publish the installer as:

`PrintAssistantSetup.exe`

Permanent download URL:

`https://github.com/precifybr/print-agent/releases/latest/download/PrintAssistantSetup.exe`

Upgrades replace the installed app and preserve local data in AppData.

## Development

Requirements:

- Node.js
- npm
- Windows with target printers

Commands:

- `npm start`
- `npm run pack`
- `npm run dist:win`
- `npm run release`
- `npm run release:win`

The generated installer is written to `dist/PrintAssistantSetup.exe`.
