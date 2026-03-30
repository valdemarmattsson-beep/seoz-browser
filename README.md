# ⚡ SEOZ Browser

En Electron-baserad desktop-browser för Windows och macOS med inbyggda SEOZ SEO-verktyg.

## Funktioner

- 🔍 **SEO-analys** — Automatisk on-page-analys vid varje sidladdning (title, meta, H1, alt-texter, schema)
- 📈 **Keywords & GSC** — Keyword-ranking och GSC-data per aktiv URL
- ✅ **Tasks** — Skapa och se SEOZ-uppgifter direkt från browsern
- 🤖 **AI Visibility** — ChatGPT, Perplexity, AI Overviews, Meta AI-synlighet
- 🔔 **Notiser** — Ranking-tappar, CWV-alerts och task-uppdateringar
- 🌙 **Light/Dark/System** — Följer SEOZ design-tokens exakt
- 🔑 **API-nyckel auth** — Lagras i OS-nyckelringen via electron-keytar
- 🔄 **Auto-sync var 30s** — Tasks och notiser hålls uppdaterade

## Installation

```bash
npm install
npm start          # Kör i dev-läge
npm run dev        # Kör med devtools
```

## Bygg distributionspaket

```bash
npm run build:win  # → dist/SEOZ Browser Setup 1.0.0.exe
npm run build:mac  # → dist/SEOZ Browser-1.0.0.dmg (x64 + arm64)
npm run build:all  # Båda plattformarna
```

## Projekstruktur

```
seoz-browser/
├── src/
│   ├── main/
│   │   └── main.js          # Electron main process
│   ├── preload/
│   │   └── preload.js       # Secure IPC bridge (contextBridge)
│   └── renderer/
│       └── index.html       # UI (HTML/CSS/JS, SEOZ design tokens)
├── assets/
│   └── icon.png / .ico / .icns
├── package.json
└── README.md
```

## API-nyckel

Hämta under **seoz.se → Inställningar → Integrationer → API**.

Format: `seoz_live_[32 hex chars]`

Nyckeln lagras säkert i OS-nyckelringen (macOS Keychain / Windows Credential Store).

## Tech stack

- **Electron v28** — BrowserView för inbäddad webläsare
- **contextBridge / IPC** — Säker kommunikation main ↔ renderer
- **electron-builder** — Bygger .dmg (macOS) och NSIS .exe (Windows)
- **electron-store** — Persistenta inställningar
- **SEOZ API** — REST JSON, Supabase RLS, Bearer token

## Arkitektur

```
main.js (Node.js)
  ├── BrowserWindow    — App-fönstret
  ├── BrowserView      — Den inbäddade webbläsaren
  ├── ipcMain          — IPC-handlers
  ├── electron-store   — Persistent lagring
  └── nativeTheme      — System light/dark detection

preload.js (contextBridge)
  └── window.seoz      — Säkert API exponerat till renderer

renderer/index.html
  ├── Auth overlay     — API-nyckel inloggning
  ├── Titlebar         — Klientväljare + sync-pill + win-controls
  ├── Address bar      — URL-inmatning
  ├── Tab bar          — Flikar
  ├── Dock (höger)     — 7 ikoner: SEO, KW, Tasks, AI, Notiser, Klienter, Inställningar
  ├── Slide panel      — Kontextpanel per ikon
  └── Status bar       — Domän, analys-status, sync-tid
```
