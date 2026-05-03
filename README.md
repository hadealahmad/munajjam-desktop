# Munajjam Desktop

**Automated Quran recitation synchronization — desktop app for Windows and macOS.**

Munajjam Desktop is an Electron app that drives the [Munajjam](https://github.com/Itqan-community/Munajjam) Python library locally on your machine. Drop in a folder of numbered audio files, hit **Start Alignment**, and get precise ayah-level timestamps — no cloud upload, no API key.

---

## Download

Go to [**Releases**](https://github.com/Itqan-community/munajjam-desktop/releases) and download the latest installer for your platform:

| Platform | File |
|----------|------|
| Windows | `Munajjam Setup x.x.x.exe` |
| macOS | `Munajjam-x.x.x.dmg` |

### First launch — Install Runtime

The app ships without the Python backend bundled. On first launch it shows an **Environment Setup** screen. Click **Install runtime** and the app will automatically:

1. Install **Python 3.12** and **FFmpeg** via your system package manager (`winget` on Windows, `brew` on macOS)
2. Download the Munajjam Python package
3. Create an isolated virtual environment at `%APPDATA%\Munajjam\runtime` (Windows) or `~/Library/Application Support/Munajjam/runtime` (macOS)

No Git required.

---

## How to use

1. **Create a workspace** — name it after the reciter or project
2. **Select an audio folder** — files must be named by surah number (`001.mp3`, `002.mp3`, …)
3. **Start Alignment** — the app runs Whisper transcription and ayah alignment in the background
4. **Review in the QA editor** — waveform editor with per-ayah timestamp editing
5. **Export** — aligned timestamps as JSON, ready to use

Audio formats supported: MP3, WAV, M4A, FLAC.

---

## Development setup

**Prerequisites:** Node.js 20+, npm

```bash
git clone https://github.com/Itqan-community/munajjam-desktop.git
cd munajjam-desktop
npm install
npm --prefix ./ui install
npm run dev
```

The app loads the Next.js UI from the local dev server on `localhost:3000`.

### Useful commands

```bash
npm run dev          # Start Electron + Next.js dev server
npm run check        # Lint + typecheck + tests (all quality gates)
npm run build        # Compile main process TypeScript
npm run build:ui     # Build Next.js static bundle
npm run test         # Run Vitest tests
npm run rebuild:native  # Rebuild better-sqlite3 after Node version change
npm run clean:generated # Remove dist/, ui/.next, ui/out, generated peaks
```

### Quality gates

```bash
npm run lint
npm run typecheck
npm run test
npm run audit:deadcode
```

All gates run together with `npm run check`.

### Architecture

```
src/          Electron main process — IPC, DB, job queue, Python process orchestration
ui/           Next.js renderer (loaded as static bundle in production)
resources/
  python/     Bundled Python entry point (align_batch_cli.py)
  installers/ Platform installer scripts (PowerShell for Windows, shell for macOS)
  data/       Quran CSV data
```

- SQLite database (WAL mode) persists jobs, alignments, and workspace state at `{userData}/munajjam.db`
- Python alignment process communicates via JSONL over stdout
- Jobs survive app restarts — stale `running` jobs are recovered to `failed` on launch

### Running Python tests

The bundled Python script has its own test suite:

```bash
# requires munajjam package installed (done automatically by the runtime installer)
python -m pytest resources/python/test_align_batch_cli.py -v
```

---

## Building a release

Builds are handled by GitHub Actions. To cut a release:

```bash
git tag v0.2.0
git push origin v0.2.0
```

This triggers the **Build Desktop App** workflow, which builds for Windows and macOS and publishes a GitHub Release with the installers attached.

---

## Related

- [Munajjam](https://github.com/Itqan-community/Munajjam) — Python library (alignment engine)
