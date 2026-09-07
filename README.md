# Codenotch for Windows

A Windows port of the [Codenotch](https://github.com/vinzdg/codenotch) idea: a
small black **notch** pinned to the top edge of the screen that shows the live
usage / credit readings of the AI coding accounts on this machine, side by
side. Hover the pill and it unfolds into a card of provider rings; move the
mouse away and it folds back. It lives in the system tray.

## What it reads

| Provider | Reading | Credential source (borrowed, never written by this app) |
|---|---|---|
| **DeepSeek** | remaining USD (the DSH harness backend) | `DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml` |
| **OpenRouter** | remaining prepaid credit | key you paste in Settings, or `OPENROUTER_API_KEY` env/file |
| **Claude** | usage windows (session / all models) | OAuth token in `~/.claude/.credentials.json` |
| **Codex** | 5h + weekly usage windows | `tokens` in `~/.codex/auth.json` |
| **Antigravity** | Gemini quota, else a local "requests today" count | Windows Credential Manager `gemini:antigravity` (Go keyring) |

Ring colors follow the original palette: 🟢 ample, 🟡 watch (< $5 / ≥80% used),
🟠 critical / token expired / sign-in needed.

Transient fetch failures keep the **last good reading** visible and mark it
*stale*. Claude Code / Codex refresh their own tokens when you use them; this
app never mints one — an expired Claude token shows *EXPIRED* until you run
`claude` once (that is deliberate, same as the macOS original).

## Requirements

- Windows 10/11 x64. DSH for the DeepSeek reading; the CLI/desktop apps for
  the providers you want to see (each ring degrades to *sign in* honestly when
  its credential is absent).

## Run / package

```sh
npm install          # first time
npm start            # dev run

npm install -D electron-packager   # once
npm run package                    # → dist/Codenotch-win32-x64/Codenotch.exe
```

## Settings (tray icon, or ⚙ on the expanded card)

- Enable/disable each provider (order is fixed left→right).
- **OpenRouter key** — no local OpenRouter credential exists on this machine,
  so paste an `sk-or-…` key here (stored in the app's own settings file), or
  set the `OPENROUTER_API_KEY` env var.
- DeepSeek credentials file + key name.
- Screen edge (top/bottom), poll interval (the notch polls more often while
  DSH is actively writing), pin open, launch at sign-in.
- **Credential probe** shows what each provider found.

## Notes

- The notch window uses `win.setShape`, so only the pill/card is clickable and
  the transparent surround never blocks the desktop.
- Antigravity endpoints are Google's own (`cloudcode-pa.googleapis.com`).
  Personal accounts get 403 on the quota endpoint (Google won't publish a
  limit), so the ring honestly shows a local *count of model requests today*
  from `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl`.
- Antigravity's credential is read from Windows Credential Manager via a tiny
  `CredRead` P/Invoke through `powershell -EncodedCommand` (`src/providers/wincred.js`).
- Debug self-check: `CODENOTCH_DEBUG=1 npm start` writes a DOM/render report to
  `debug/report.json` after the first poll, then quits.
