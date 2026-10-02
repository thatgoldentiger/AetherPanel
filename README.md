# AetherPanel

Self-hosted game server panel: password login, one-click server creation with automatic downloads, start/stop/restart, live console, file manager and editor.

| Game | What gets downloaded automatically |
|---|---|
| Minecraft | Paper, Vanilla, Purpur or Fabric at the version you pick, plus the exact Java runtime that version needs |
| Terraria | Official dedicated server from terraria.org at the version you pick |
| Valheim | Dedicated server via SteamCMD |
| Custom | Nothing; you upload files and give a start command |

Version dropdowns are loaded live from the official sources, so new releases show up without updating the panel.

## Install (Ubuntu/Debian)

```bash
git clone https://github.com/thatgoldentiger/AetherPanel.git
cd AetherPanel
sudo bash setup.sh
```

The script asks you to choose the panel password, then installs Node.js, Java, SteamCMD, 32-bit libraries and Playit.gg.
Non-interactive: `sudo AETHER_PASSWORD='yourpassword' bash setup.sh`

## Uninstall

- From a terminal: `sudo aetherpanel-uninstall` (or `sudo bash uninstall.sh` from the repo)
- From the panel: Settings -> Uninstall AetherPanel (asks for your password)

You can choose to keep your game servers and worlds. Java and other system packages are left installed.

## Repo files

```
setup.sh  uninstall.sh  server.js  installers.js  package.json  public/index.html
```

Installed to `/opt/aetherpanel` (data in `data/servers/srv-*`, Java runtimes in `data/java`, password in `.password`).

## Commands

```bash
sudo systemctl restart aetherpanel     # also stops running game servers
sudo journalctl -u aetherpanel -f      # panel logs
sudo journalctl -u playit -n 20        # Playit claim link
```

Change the password in Settings, or set `PANEL_PASSWORD` in the service environment.

## Security

Only expose port 3000 to the internet behind HTTPS (Nginx/Cloudflare). The panel can run commands as the `aether` user, so use a strong password.
