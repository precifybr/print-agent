# Print Assistant

Private Electron desktop agent for authenticated local printing in the DALMAGO ecosystem.

## Repository contents

- Electron app source: `main.js`, `preload.js`, `index.html`
- Windows packaging assets: `build/`
- Build and release notes: `docs/BUILD.md`
- Print network contract and Supabase backend pieces: `docs/PRINT_NETWORK.md`, `supabase/`

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
