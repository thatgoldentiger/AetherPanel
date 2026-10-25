# AetherPanel

Self-hosted game server panel: password login, one-click server creation with automatic downloads, start/stop/restart, live console, a Players tab (kick/ban/op), a file manager and editor, per-server icons, renaming, and the ability to change a server's version in place.

## Install (Ubuntu/Debian)

```bash
git clone https://github.com/thatgoldentiger/AetherPanel.git
cd AetherPanel
sudo bash setup.sh
```

The script asks you to choose the panel password, then installs Node.js, Java, SteamCMD and 32-bit libraries.
Non-interactive: `sudo AETHER_PASSWORD='yourpassword' bash setup.sh`

To play from outside your home network, forward the relevant port(s) on your router to this machine's local IP - the panel doesn't set up or depend on any tunnelling service.

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
- Port forwarding: Minecraft uses **TCP**.
- Accepting the EULA is required and handled automatically (`eula.txt` is written for you).

### Terraria
- Pick an official server version and a world size. A new world is created on first start.
- There is no way to force Corruption or Crimson on an auto-generated world - the dedicated server always picks randomly. To choose a biome, generate the world yourself and upload it in the Files tab.
- Port forwarding: Terraria uses **TCP**, not UDP.
- Vanilla Terraria has no "operator" concept, so the Players tab only offers Kick and Ban for it, with no reason field (vanilla ignores it) and no guaranteed unban without a restart.

### Terraria + tModLoader (experimental)
- Downloads the tModLoader dedicated server via SteamCMD. This is new and less tested than the other games - the generated start command may need adjusting in Settings depending on the exact build. Mods (`.tmod` files) are uploaded into the `Mods` folder via the Files tab, then enabled with the in-console `enablemods` command.

### Valheim
- Only the latest Steam build is offered (Valheim has no public version list). A password is **optional** - it's only required by Valheim when a server is publicly listed, and this panel always creates unlisted (`-public 0`) servers.
- Port forwarding: Valheim uses **UDP** ports 2456-2458.
- **Important - how Valheim actually saves:** unlike Minecraft and Terraria, the vanilla Valheim dedicated server does not read commands from its console at all - `save`, `kick`, `ban` only exist as in-game admin commands sent by a connected player, over the network, not something the panel can type into the process. Because of that, Valheim servers here don't get the Stop-command/Auto-save-command boxes other games do - they would silently do nothing. Instead:
  - It saves automatically on its own schedule via a built-in `-saveinterval <seconds>` flag the panel sets (default 10 minutes; edit the number in the start command in Settings to change it).
  - It writes a full save when cleanly **Stopped or Restarted** (the server catches that signal and flushes a save before exiting) - this is why **Kill should only be used as a last resort**, since it skips that save entirely.
  - The panel also waits noticeably longer before force-killing a Valheim server on Stop/Restart than it does for other games, specifically so a save in progress on a large world isn't cut off mid-write.
  - Banning/op-ing works by editing `adminlist.txt`/`bannedlist.txt` (by Steam ID) in the server's save folder; a ban takes effect on that player's next connection attempt rather than instantly. There is no live Kick for Valheim for the same reason as above.

### Custom command
- For any other game server. Upload your files in the Files tab and set a Start command; nothing is downloaded automatically.

## Players tab

- **Minecraft**: full support via a local RCON connection the panel sets up automatically - online list, kick, ban, op/deop and unban, each with a reason where Minecraft supports one, plus TPS. TPS only shows a number on Paper/Purpur (`/tps`) or servers exposing `/tick query`; Vanilla, Fabric, Forge and NeoForge usually show "N/A" unless you add a plugin/mod for it.
- **Terraria**: online players are detected by watching the console for join/leave messages. Kick and Ban are sent as console commands; no reason field, no Op.
- **Valheim**: online players (by Steam ID, name only once known) are detected the same way. Ban/Admin edit the list files described above; no live Kick.
- **Custom servers**: no player management (the panel doesn't know the game's protocol).

## Renaming, icons, versions and commands

- **Settings** tab: rename a server, change its icon (a small original icon is shown by default for each game - not the official trademarked logos, just a simple generic glyph; upload your own PNG/JPG/GIF/WEBP, 2 MB max, if you'd rather use something else), change its version/software in place (server must be stopped first; your world/save is kept), and edit its Start and Stop commands directly (Valheim excluded - see above). Restart the server for a changed Start command to take effect.
- An optional **Auto-save** can run commands on an interval while the server is up (not available for Valheim, for the same console-access reason above).
- Servers are shown as a row of icons at the top of the page instead of a dropdown, so you can tell them apart at a glance.

## Settings reference

| What | Where |
|---|---|
| Panel password | Settings -> Change panel password, or set via `PANEL_PASSWORD` in the service environment |
| Panel port | `PORT` in `/etc/systemd/system/aetherpanel.service` (default 3000) |

## Commands

```bash
sudo systemctl restart aetherpanel     # also stops running game servers - can take a few minutes if a Valheim save is in progress
sudo journalctl -u aetherpanel -f      # panel logs
```

## Repo files

```
setup.sh  uninstall.sh  server.js  installers.js  players.js  package.json  public/index.html
```

Installed to `/opt/aetherpanel` (game data in `data/servers/srv-*`, Java runtimes in `data/java`, icons in `data/icons`, password in `.password`).

## Security

Only expose port 3000 to the internet behind HTTPS (Nginx/Cloudflare). The panel runs game servers and shell commands as the `aether` user, so use a strong password. RCON used for Minecraft player management is bound to localhost only and never exposed externally.
