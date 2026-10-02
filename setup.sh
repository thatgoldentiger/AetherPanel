#!/bin/bash
# AetherPanel setup script (Ubuntu 20.04+/Debian 11+; RHEL-family best effort)
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash setup.sh"
  exit 1
fi

INSTALL_DIR="/opt/aetherpanel"
REPO_RAW="https://raw.githubusercontent.com/thatgoldentiger/AetherPanel/main"

echo "[1/6] Installing system packages..."
if command -v apt-get &> /dev/null; then
    apt-get update -y
    apt-get install -y curl wget git build-essential screen unzip ufw gnupg
elif command -v dnf &> /dev/null; then
    dnf install -y curl wget git make gcc gcc-c++ screen unzip
fi

echo "[2/6] Installing Node.js 20..."
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    if command -v apt-get &> /dev/null; then apt-get install -y nodejs; else dnf install -y nodejs; fi
fi

echo "[3/6] Installing Java 21..."
if command -v apt-get &> /dev/null; then
    apt-get install -y openjdk-21-jre-headless || apt-get install -y default-jre-headless
else
    dnf install -y java-21-openjdk-headless
fi

echo "[4/6] Installing Playit.gg agent..."
curl -fsSL https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64 -o /usr/local/bin/playit
chmod +x /usr/local/bin/playit

echo "[5/6] Installing panel files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/public" "$INSTALL_DIR/data/servers"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" 2>/dev/null && pwd )"
if [ -f "$SCRIPT_DIR/server.js" ] && [ -f "$SCRIPT_DIR/public/index.html" ]; then
    cp -f "$SCRIPT_DIR/server.js" "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
    cp -f "$SCRIPT_DIR/public/index.html" "$INSTALL_DIR/public/"
else
    curl -fsSL "$REPO_RAW/server.js" -o "$INSTALL_DIR/server.js"
    curl -fsSL "$REPO_RAW/package.json" -o "$INSTALL_DIR/package.json"
    curl -fsSL "$REPO_RAW/public/index.html" -o "$INSTALL_DIR/public/index.html"
fi

# Panel password (kept if it already exists)
if [ ! -f "$INSTALL_DIR/.env" ]; then
    NEWPASS=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16)
    echo "PANEL_PASSWORD=$NEWPASS" > "$INSTALL_DIR/.env"
fi
chmod 600 "$INSTALL_DIR/.env"

# Run everything as an unprivileged user
id aether &> /dev/null || useradd -r -d "$INSTALL_DIR" -s /usr/sbin/nologin aether
cd "$INSTALL_DIR"
npm install --omit=dev
chown -R aether:aether "$INSTALL_DIR"

echo "[6/6] Registering services and firewall rules..."
cat > /etc/systemd/system/aetherpanel.service <<'UNIT'
[Unit]
Description=AetherPanel Game Management Daemon
After=network.target

[Service]
Type=simple
User=aether
WorkingDirectory=/opt/aetherpanel
EnvironmentFile=/opt/aetherpanel/.env
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
    ufw allow 2456:2457/udp comment 'Valheim'
    echo "y" | ufw enable || true
fi

systemctl daemon-reload
systemctl enable aetherpanel playit
systemctl restart aetherpanel
systemctl restart playit

IP_ADDR=$(hostname -I | awk '{print $1}')
echo "===================================================="
echo " AetherPanel installed!"
echo " Panel:     $(systemctl is-active aetherpanel)"
echo " Playit:    $(systemctl is-active playit)"
echo " URL:       http://${IP_ADDR}:3000"
echo " Password:  $(grep PANEL_PASSWORD "$INSTALL_DIR/.env" | cut -d= -f2)"
echo " (change it in $INSTALL_DIR/.env, then: systemctl restart aetherpanel)"
echo " Playit claim link: journalctl -u playit -n 20 --no-pager"
echo "===================================================="
