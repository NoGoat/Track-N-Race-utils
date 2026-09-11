# TNRD Viewer

Standalone Electron + Vite + React inspector for Track N Race `.tnrd` recordings.

- Opens TNRD V1, V2, V3, V4, and V5 without using `libtnrp`.
- Displays physical, timeline, and logical-sequence chunk maps.
- Shows V5 wall-clock branches and active/clipped/superseded chunks.
- Uses React Select for the Lap, Family, and Branch dropdowns, including the
  same enter/exit animations as the main Track N Race Electron frontend.
- Double-clicking a chunk decompresses it in Electron's Node main process and
  opens a searchable, paginated raw JSONL viewer.
- V1–V3 monolithic streams are decompressed to a temporary file and represented
  as logical 4,096-row blocks. Temporary files are removed when the recording
  or app closes.
- Includes local copies of the Track N Race application icon and all renderer
  assets needed after moving this directory.

```powershell
cd tools/tnrd-viewer
npm install
npm run dev
```

You can also pass a recording on the command line:

```powershell
npm run dev -- "C:\recordings\session.tnrd"
```
