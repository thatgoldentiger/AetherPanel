# AetherPanel

Self-hosted game server panel: password login, start/stop/restart, live console, file manager and editor. Minecraft (Paper) is downloaded automatically; Terraria, Valheim and anything else run from a start command with files you upload.

## Install (Ubuntu/Debian)

```bash
git clone https://github.com/thatgoldentiger/AetherPanel.git
cd AetherPanel
sudo bash setup.sh
```

Or in one line: `curl -sSL https://raw.githubusercontent.com/thatgoldentiger/AetherPanel/main/setup.sh | sudo bash`

The script prints the dashboard URL and a generated password at the end.

## Layout

```
Repo:                         Installed at /opt/aetherpanel:
setup.sh                      server.js, package.json, .env (password)
server.js                     public/index.html
package.json                  data/config.json
public/index.html             data/servers/srv-*/  (one folder per game server)
```

## Settings

| What | Where |
|---|---|
| Panel password | `/opt/aetherpanel/.env` (`PANEL_PASSWORD=`), then `sudo systemctl restart aetherpanel` |
| Port | `PORT` in `/etc/systemd/system/aetherpanel.service` (default 3000) |

## Commands

```bash
sudo systemctl restart aetherpanel     # restart panel (also stops running game servers)
sudo journalctl -u aetherpanel -f      # panel logs
sudo journalctl -u playit -n 20        # Playit claim link
```

## Security

Only expose port 3000 to the internet behind HTTPS (Nginx/Cloudflare). The panel can run commands as the `aether` user, so use a strong password.
