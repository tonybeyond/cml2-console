# CML2 Console Manager

A lightweight browser-based console manager for [Cisco Modeling Labs 2](https://developer.cisco.com/modeling-labs/) (CML2). Connect to device consoles directly from your browser — no SSH client, no Cisco UI required.

![CML2 Console Manager](https://raw.githubusercontent.com/tonybeyond/cml2-console/main/docs/screenshot.png)

## Features

- **Lab browser** — lists all your CML2 labs with live state badges (STARTED / STOPPED / DEFINED)
- **Device tree** — expands each lab to show nodes with their state; only BOOTED devices are connectable
- **Multi-tab terminals** — open multiple device consoles simultaneously in separate tabs
- **Full xterm.js terminal** — colour support, scrollback, proper resize handling
- **Reconnect** — press `Ctrl+R` on a disconnected tab to reconnect without refreshing the page
- **Zero client install** — runs entirely in the browser; works from any machine on your network

## Requirements

- CML2 instance **2.10+** reachable from the host running this app
- Docker + Docker Compose **or** Node.js 18+

## Quick start (Docker Compose)

```bash
git clone https://github.com/tonybeyond/cml2-console.git
cd cml2-console
cp .env.example .env
# Edit .env and set CML_HOST to your CML2 IP or hostname
docker compose up -d
```

Open **http://localhost:3001** and log in with your CML2 credentials.

## Configuration

All configuration is done via environment variables (or a `.env` file):

| Variable   | Required | Default | Description                          |
|------------|----------|---------|--------------------------------------|
| `CML_HOST` | Yes      | —       | IP or hostname of your CML2 instance |
| `PORT`     | No       | `3001`  | Host port to expose the web UI on    |

`.env` example:

```env
CML_HOST=192.168.1.100
PORT=3001
```

## Running without Docker

```bash
npm install
CML_HOST=192.168.1.100 node server.js
```

## How it works

```
Browser  ──WebSocket──▶  Node proxy  ──WebSocket──▶  CML2 /ws/dispatch/frontend/console
         ◀─────────────              ◀───────────────
```

The Node.js server acts as a proxy between your browser and CML2:

1. **Auth** — proxies login to `POST /api/v0/authenticate` and returns a JWT
2. **Labs & nodes** — proxies REST calls to CML2, normalising field names across versions
3. **Console** — fetches a one-time console key from `/api/v0/labs/{id}/nodes/{id}/keys/console`, then opens `wss://CML_HOST/ws/dispatch/frontend/console?action=lab_exec&uuid=<key>` and tunnels the stream to the browser over a local WebSocket

This approach is necessary because:
- CML2 uses self-signed TLS that browsers reject
- The browser WebSocket API cannot set custom auth headers

## Project structure

```
.
├── server.js          # Express + WebSocket proxy
├── public/
│   ├── index.html     # Single-page app shell
│   ├── app.js         # Frontend logic (vanilla JS)
│   └── style.css      # Dark GitHub-inspired theme
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## License

MIT
