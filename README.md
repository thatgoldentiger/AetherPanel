# AetherPanel

Self-hosted game server panel: password login, one-click server creation with automatic downloads, start/stop/restart, live console, a Players tab (kick/ban/op), a file manager and editor, per-server icons, and renaming.

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
- From the panel: Settings -> Danger zone -> Uninstall AetherPanel (asks for your password)

You can choose to keep your game servers and worlds. Java and other system packages are left installed.

## Creating a server - a guide for each game

Open **+ New Server**, pick a game, and the version dropdown loads live from the official source for that game/engine, so new releases show up automatically.

### Minecraft
- **Paper, Purpur, Fabric, Vanilla**: pick a Minecraft version; the matching server file downloads automatically, along with the exact Java release that version needs.
- **Forge / NeoForge**: pick a Minecraft version; the panel downloads the recommended Forge/NeoForge installer for that version, runs it, and detects the resulting launch script (`run.sh`) or jar automatically. This detection is newer and less tested than the others - if a modded server doesn't start, check the Files tab for what actually got installed and fix the **Start command** in Settings.
- **Custom (upload your own jar)**: skips downloading anything. After creating the server, go to Files and upload your file as `server.jar`, then press Start.
- Port forwarding/Playit: Minecraft uses **TCP**.
- Accepting the EULA is required and handled automatically (`eula.txt` is written for you).

### Terraria
- Pick an official server version, a world size (Small/Medium/Large) and a world type (Random/Corruption/Crimson). A new world is created on first start.
- Port forwarding/Playit: Terraria uses **TCP**, not UDP - if you can't connect, this is the most common cause. (An earlier version of this panel's firewall script opened the wrong protocol; `setup.sh` now opens 7777/tcp.)
- Vanilla Terraria has no "operator" concept, so the Players tab only offers Kick and Ban for it, with no reason field (vanilla ignores it) and no guaranteed unban without a restart.

### Terraria + tModLoader (experimental)
- Downloads the tModLoader dedicated server via SteamCMD. This is new and less tested than the other games - the generated start command may need adjusting in Settings depending on the exact build. Mods (`.tmod` files) are uploaded into the `Mods` folder via the Files tab, then enabled with the in-console `enablemods` command.

### Valheim
- Only the latest Steam build is offered (Valheim has no public version list). Set a server password (5-30 letters/numbers).
- Port forwarding/Playit: Valheim uses **UDP** ports 2456-2458.
- Valheim has no live "kick" from the console. Banning/op-ing works by editing `adminlist.txt`/`bannedlist.txt` (by Steam ID) in the server's save folder; a ban takes effect on that player's next connection attempt rather than instantly.

### Custom command
- For any other game server. Upload your files in the Files tab and set a Start command; nothing is downloaded automatically.

## Players tab

- **Minecraft**: full support via a local RCON connection the panel sets up automatically - online list, kick, ban, op/deop and unban, each with a reason where Minecraft supports one, plus TPS. TPS only shows a number on Paper/Purpur (`/tps`) or servers exposing `/tick query`; Vanilla, Fabric, Forge and NeoForge usually show "N/A" unless you add a plugin/mod for it.
- **Terraria**: online players are detected by watching the console for join/leave messages. Kick and Ban are sent as console commands; no reason field, no Op.
- **Valheim**: online players (by Steam ID, name only once known) are detected the same way. Ban/Admin edit the list files described above; no live Kick.
- **Custom servers**: no player management (the panel doesn't know the game's protocol).

## Renaming, icons, and commands

- **Settings** tab: rename a server, change its icon (defaults to an emoji per game; upload your own PNG/JPG/GIF/WEBP, 2 MB max), and edit its Start and Stop commands directly. The Stop command is what's sent to the console when you click Stop (leave it blank to force-terminate instead); restart the server for a changed Start command to take effect.
- Servers are shown as a row of icons at the top of the page instead of a dropdown, so you can tell them apart at a glance.

## Settings reference

| What | Where |
|---|---|
| Panel password | Settings -> Change panel password, or set via `PANEL_PASSWORD` in the service environment |
| Panel port | `PORT` in `/etc/systemd/system/aetherpanel.service` (default 3000) |

## Commands

```bash
sudo systemctl restart aetherpanel     # also stops running game servers
sudo journalctl -u aetherpanel -f      # panel logs
sudo journalctl -u playit -n 20        # Playit claim link
```

## Repo files

```
setup.sh  uninstall.sh  server.js  installers.js  players.js  package.json  public/index.html
```

Installed to `/opt/aetherpanel` (game data in `data/servers/srv-*`, Java runtimes in `data/java`, icons in `data/icons`, password in `.password`).

## Security

Only expose port 3000 to the internet behind HTTPS (Nginx/Cloudflare). The panel runs game servers and shell commands as the `aether` user, so use a strong password. RCON used for Minecraft player management is bound to localhost only and never exposed externally.
