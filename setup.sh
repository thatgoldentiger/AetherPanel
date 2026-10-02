#!/bin/bash
# AetherPanel setup (Ubuntu 20.04+/Debian 11+; RHEL-family best effort)
# Non-interactive: sudo AETHER_PASSWORD='yourpassword' bash setup.sh
set -e

if [ "$EUID" -ne 0 ]; then echo "Please run as root: sudo bash setup.sh"; exit 1; fi

INSTALL_DIR="/opt/aetherpanel"
REPO_RAW="https://raw.githubusercontent.com/thatgoldentiger/AetherPanel/main"
PASS=""

# ---- choose the panel password first ----
if [ -n "$AETHER_PASSWORD" ]; then
  PASS="$AETHER_PASSWORD"
elif [ -f "$INSTALL_DIR/.password" ] && [ -r /dev/tty ]; then
  read -r -p "A panel password already exists. Keep it? [Y/n] " K < /dev/tty
  [[ "$K" =~ ^[Nn]$ ]] || PASS="__KEEP__"
fi
if [ -z "$PASS" ]; then
  if [ ! -r /dev/tty ]; then
    echo "No terminal available to ask for a password."
    echo "Re-run with: sudo AETHER_PASSWORD='yourpassword' bash setup.sh"
    exit 1
  fi
  while true; do
    read -r -s -p "Choose a panel password (min 8 characters): " P1 < /dev/tty; echo
    read -r -s -p "Confirm password: " P2 < /dev/tty; echo
    if [ "${#P1}" -ge 8 ] && [ "$P1" = "$P2" ]; then PASS="$P1"; break; fi
    echo "Passwords must match and be at least 8 characters."
  done
fi
if [ "$PASS" != "__KEEP__" ] && [ "${#PASS}" -lt 8 ]; then echo "Password must be at least 8 characters."; exit 1; fi

echo "[1/7] Installing system packages..."
if command -v apt-get &> /dev/null; then
  dpkg --add-architecture i386 || true
  apt-get update -y
  apt-get install -y curl wget git unzip tar ufw sudo ca-certificates gnupg screen
  # 32-bit libraries needed by SteamCMD (Valheim)
  apt-get install -y lib32gcc-s1 lib32stdc++6 || apt-get install -y lib32gcc1 lib32stdc++6 || true
elif command -v dnf &> /dev/null; then
  dnf install -y curl wget git unzip tar sudo ca-certificates screen glibc.i686 libstdc++.i686 || true
fi

echo "[2/7] Installing Node.js 20..."
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  if command -v apt-get &> /dev/null; then apt-get install -y nodejs; else dnf install -y nodejs; fi
fi

echo "[3/7] Installing Java (system copy; the panel also fetches the exact version each server needs)..."
if command -v apt-get &> /dev/null; then
  apt-get install -y openjdk-21-jre-headless || apt-get install -y openjdk-17-jre-headless || true
else
  dnf install -y java-21-openjdk-headless || dnf install -y java-17-openjdk-headless || true
fi

echo "[4/7] Installing SteamCMD (Valheim) and Playit.gg..."
mkdir -p /opt/steamcmd
curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar xz -C /opt/steamcmd
case "$(uname -m)" in aarch64|arm64) PLAYIT=playit-linux-aarch64 ;; *) PLAYIT=playit-linux-amd64 ;; esac
curl -fsSL "https://github.com/playit-cloud/playit-agent/releases/latest/download/$PLAYIT" -o /usr/local/bin/playit
chmod +x /usr/local/bin/playit

echo "[5/7] Installing panel files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/public" "$INSTALL_DIR/data/servers"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" 2>/dev/null && pwd )"
if [ -f "$SCRIPT_DIR/server.js" ] && [ -f "$SCRIPT_DIR/installers.js" ] && [ -f "$SCRIPT_DIR/public/index.html" ]; then
  cp -f "$SCRIPT_DIR/server.js" "$SCRIPT_DIR/installers.js" "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
  cp -f "$SCRIPT_DIR/public/index.html" "$INSTALL_DIR/public/"
  cp -f "$SCRIPT_DIR/uninstall.sh" /usr/local/sbin/aetherpanel-uninstall
else
  for f in server.js installers.js package.json; do curl -fsSL "$REPO_RAW/$f" -o "$INSTALL_DIR/$f"; done
  curl -fsSL "$REPO_RAW/public/index.html" -o "$INSTALL_DIR/public/index.html"
  curl -fsSL "$REPO_RAW/uninstall.sh" -o /usr/local/sbin/aetherpanel-uninstall
fi
# The uninstaller must be root-owned so the panel user can't modify it
chown root:root /usr/local/sbin/aetherpanel-uninstall
chmod 755 /usr/local/sbin/aetherpanel-uninstall

[ "$PASS" != "__KEEP__" ] && printf '%s' "$PASS" > "$INSTALL_DIR/.password"
chmod 600 "$INSTALL_DIR/.password"
rm -f "$INSTALL_DIR/.env"

id aether &> /dev/null || useradd -r -d "$INSTALL_DIR" -s /usr/sbin/nologin aether
cd "$INSTALL_DIR"
npm install --omit=dev
chown -R aether:aether "$INSTALL_DIR" /opt/steamcmd

# Allow the panel user to run ONLY the uninstaller as root (used by the Uninstall button)
cat > /etc/sudoers.d/aetherpanel <<'S'
aether ALL=(root) NOPASSWD: /usr/local/sbin/aetherpanel-uninstall --yes, /usr/local/sbin/aetherpanel-uninstall --yes --keep-data
S
chmod 440 /etc/sudoers.d/aetherpanel
visudo -cf /etc/sudoers.d/aetherpanel > /dev/null || rm -f /etc/sudoers.d/aetherpanel

echo "[6/7] Pre-downloading Java 21, 17 and 8 (this can take a minute)..."
runuser -u aether -- node "$INSTALL_DIR/installers.js" prefetch || true

echo "[7/7] Registering services and firewall rules..."
cat > /etc/systemd/system/aetherpanel.service <<'UNIT'
[Unit]
Description=AetherPanel Game Management Daemon
After=network.target

[Service]
Type=simple
User=aether
WorkingDirectory=/opt/aetherpanel
Environment=NODE_ENV=production PORT=3000
ExecStart=/usr/bin/node /opt/aetherpanel/server.js
Restart=always
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/playit.service <<'UNIT'
[Unit]
Description=Playit.gg Tunneling Agent
After=network.target

[Service]
Type=simple
User=aether
WorkingDirectory=/opt/aetherpanel
ExecStart=/usr/local/bin/playit
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

if command -v ufw &> /dev/null; then
  ufw allow 22/tcp comment 'SSH'
  ufw allow 3000/tcp comment 'AetherPanel Dashboard'
  ufw allow 25565/tcp comment 'Minecraft Java'
  ufw allow 7777/udp comment 'Terraria'
  ufw allow 2456:2458/udp comment 'Valheim'
  echo "y" | ufw enable || true
fi

systemctl daemon-reload
systemctl enable aetherpanel playit
systemctl restart aetherpanel
systemctl restart playit

IP_ADDR=$(hostname -I | awk '{print $1}')
echo "===================================================="
echo " AetherPanel installed!"
echo " Panel:  $(systemctl is-active aetherpanel)"
echo " Playit: $(systemctl is-active playit)"
echo " URL:    http://${IP_ADDR}:3000"
echo " Log in with the password you just chose."
echo " Playit claim link: sudo journalctl -u playit -n 20 --no-pager"
echo " Uninstall: sudo aetherpanel-uninstall (or the button in Settings)"
echo "===================================================="
