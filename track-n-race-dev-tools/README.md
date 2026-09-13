# Track N Race Dev Tools

One Electron application containing the TNRD Viewer and RAM Usage Viewer.

Use the transparent React Select control in the shared titlebar to switch tools. Both pages remain mounted while switching, so an open recording, an open RAM log, filters, selections, and scroll state are preserved. The titlebar, theme, open action, window controls, and persisted theme setting are owned by the application shell rather than duplicated by each viewer. The last selected tool is restored on the next launch.

## Supported files

- **TNRD Viewer:** `.tnrd` recordings from TNRD V1 through V5
- **RAM Usage Viewer:** `ram_usage.log`, `.log`, `.jsonl`, and `.json` diagnostics logs

Opening a supported file through the command line or a second application instance automatically activates the matching tool.

## Scripts

- `npm run dev` — open the development build
- `npm run typecheck` — check the Electron and renderer TypeScript projects
- `npm run build` — create the production bundles
- `npm start` — preview the production bundles
