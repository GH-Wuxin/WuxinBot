# Wuxin — QQ Group Chat AI Bot

A local Windows QQ group-chat AI bot with a Chinese GUI, connected to QQ through NapCat OneBot.

## Quick Start

1. Install [NapCat](https://github.com/NapNeko/NapCatQQ) and log in your bot QQ account
2. Clone this repo
3. Copy `.env.example` to `.env` and fill in your API key
4. `npm install && npm run dev`
5. Open http://127.0.0.1:5173 — click "Auto Detect" on the QQ Connection page, then "Save & Connect"

## Requirements

- Node.js 20+
- NapCat (or any OneBot v11 compatible client)
- DeepSeek API key (or any OpenAI-compatible provider)

## Features

- **Multi-group support** with per-group reply modes (silent / @mention / light / natural)
- **Per-member policies** — admin, trusted, muted, blocked, with custom prompts
- **Long-term memory** — context-aware personal profiles, group atmosphere profiles, relationship profiles
- **Auto model switching** — upgrades to V4 Pro for complex tasks
- **Web search** — DeepSeek built-in search
- **Scene presets** — one-click mode switching (class / away / sleep / active / debug)
- **Backup system** — auto-backup every 8 hours, manual backup via GUI
- **Decision sandbox** — test bot behavior without sending real QQ messages

## Architecture

```
NapCat QQ → OneBot WS → server/onebot.ts → server/bot.ts → LLM → OneBot HTTP → QQ
                                  ↑
React GUI ← Vite :5173 ← Express :8787 ← server/store.ts → %APPDATA%/Wuxin/db.json
```

## Commands

All commands use `/w` prefix (or `/wuxin`). Use `/w help` to see available commands.

## Configuration

- **Data**: stored in `%APPDATA%\Wuxin\db.json` (customizable via `DATA_DIR` env var)
- **API**: set `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_API_BASE_URL` in `.env`
- **OneBot**: HTTP/WSS URLs configured in GUI

## Development

```bash
npm run build      # Build frontend
npm run sanity     # Run integration tests
npm run structure  # Check module structure
```

## License

MIT
