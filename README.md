# AetherPanel - Game Server Management Daemon

A lightweight, self-hosted Game Server Control Panel with live WebSocket terminal streaming, multi-game engine wizard (Minecraft, Terraria, Valheim), built-in file editor, and zero-port-forwarding tunneling support via Playit.gg.

---

## 🚀 Quick Automated Installation

Upload all repository files (`setup.sh`, `package.json`, `server.js`, `public/index.html`, `README.md`) to a public or private GitHub repository.

Run this single command on your Linux server (**Ubuntu 20.04/22.04/24.04** or **Debian 11/12**):

```bash
curl -sSL https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME/main/setup.sh | sudo bash
```

> ⚠️ **Note:** Replace `YOUR_GITHUB_USERNAME` and `YOUR_REPO_NAME` with your actual GitHub username and repository name before running.

---

## ⚙️ Things You May Want to Customise or Change

While `setup.sh` automatically configures 99% of your server, here are the key configuration settings you can modify:

| File | Setting | Default Value | Description |
|---|---|---|---|
| `server.js` | `PORT` | `3000` | Port for the web dashboard dashboard API. |
| `public/index.html` | `PANEL_CONFIG.panelName` | `"AetherPanel"` | Branding title displayed across the header and UI. |
| `public/index.html` | `PANEL_CONFIG.defaultTheme` | `"theme-blue"` | Theme accent (`theme-blue`, `theme-emerald`, `theme-violet`, `theme-amber`). |
| `setup.sh` | Node / Java Versions | Node 20 LTS, OpenJDK 21 | Runtime dependencies for Minecraft 1.20+. |

---

## 🔗 Playit.gg Tunnel Setup (Zero Port Forwarding)

The automated script installs and enables `playit` as a background systemd daemon.

1. Fetch your Playit claim link after running `setup.sh`:
   ```bash
   sudo journalctl -u playit -n 20 --no-pager
   ```
2. Copy the `https://playit.gg/claim/...` URL output from the logs and open it in your browser.
3. Link the agent to your Playit.gg account to map public addresses to your local server ports (e.g., `25565`, `7777`, `2456-2457`).

---

## 🛠️️ Service Management Commands

| Action | Command |
|---|---|
| Start Panel Daemon | `sudo systemctl start aetherpanel` |
| Stop Panel Daemon | `sudo systemctl stop aetherpanel` |
| Restart Panel Daemon | `sudo systemctl restart aetherpanel` |
| Check Panel Status | `sudo systemctl status aetherpanel` |
| View Real-time Logs | `sudo journalctl -u aetherpanel -f` |
| View Playit Tunnel Logs | `sudo journalctl -u playit -f` |

---

## 📁 Installation Layout (`/opt/aetherpanel`)

```text
/opt/aetherpanel/
├── data/
│   ├── config.json          # Registered game server metadata
│   └── servers/             # Isolated working folders for server files
│       ├── srv-1/           # Server 1 files (e.g. paper.jar, server.properties)
│       └── srv-.../
├── public/
│   └── index.html           # Single-file frontend UI
├── package.json             # NPM dependencies
└── server.js                # Daemon backend & WebSocket engine
```

---

## 🔒 Security Recommendations

If hosting on a public IP address:
- Reverse proxy through Nginx or Cloudflare with SSL (HTTPS).
- Restrict dashboard access using `ufw` or basic auth middleware if exposed directly to the WAN.