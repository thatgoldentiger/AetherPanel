#!/bin/bash
# ==============================================================================
#  AetherPanel Fully Automated Linux Setup Script
#  Supported OS: Ubuntu 20.04/22.04/24.04, Debian 11/12, RHEL/CentOS 8/9
# ==============================================================================

set -e

# Ensure script is run with root permissions
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root or with sudo:"
  echo "sudo bash setup.sh"
  exit 1
fi

echo "===================================================="
echo "    Installing AetherPanel & Automated Daemon      "
echo "===================================================="

# 1. System Package Updates & Essential Tooling
echo "[1/6] Updating system repositories and dependencies..."
if command -v apt-get &> /dev/null; then
    apt-get update -y
    apt-get install -y curl wget git build-essential screen unzip ufw gnupg software-properties-common
elif command -v dnf &> /dev/null; then
    dnf install -y curl wget git make gcc gcc-c++ screen unzip ufw
fi

# 2. Node.js 20 LTS Runtime Setup
echo "[2/6] Installing Node.js 20 LTS Runtime..."
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    if command -v apt-get &> /dev/null; then
        apt-get install -y nodejs
    elif command -v dnf &> /dev/null; then
        dnf install -y nodejs
    fi
fi

# 3. Java OpenJDK 21 Setup (For Minecraft 1.20+)
echo "[3/6] Installing OpenJDK 21 JRE..."
if command -v apt-get &> /dev/null; then
    apt-get install -y openjdk-21-jre-headless || apt-get install -y default-jre
elif command -v dnf &> /dev/null; then
    dnf install -y java-21-openjdk
fi

# 4. Playit.gg Tunneling Daemon Setup
echo "[4/6] Installing Playit.gg Agent..."
curl -SsL https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64 -o /usr/local/bin/playit
chmod +x /usr/local/bin/playit

# 5. Directory Structure & File Copying
echo "[5/6] Provisioning /opt/aetherpanel directory..."
INSTALL_DIR="/opt/aetherpanel"
mkdir -p "$INSTALL_DIR/public"
mkdir -p "$INSTALL_DIR/data/servers"

# Copy local repository files if setup.sh is run from inside cloned repo
REPO_RAW="https://raw.githubusercontent.com/thatgoldentiger/AetherPanel/main"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" 2>/dev/null && pwd )"

if [ -f "$SCRIPT_DIR/server.js" ]; then
    cp -f "$SCRIPT_DIR/server.js" "$INSTALL_DIR/"
    [ -f "$SCRIPT_DIR/package.json" ] && cp -f "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
    cp -f "$SCRIPT_DIR/public/index.html" "$INSTALL_DIR/public/"
else
    curl -fsSL "$REPO_RAW/server.js" -o "$INSTALL_DIR/server.js"
    curl -fsSL "$REPO_RAW/package.json" -o "$INSTALL_DIR/package.json"
    curl -fsSL "$REPO_RAW/public/index.html" -o "$INSTALL_DIR/public/index.html"
fi

# Fallback package.json if missing
if [ ! -f "$INSTALL_DIR/package.json" ]; then
cat << 'EOF' > "$INSTALL_DIR/package.json"
{
  "name": "aetherpanel-daemon",
  "version": "1.0.0",
  "description": "AetherPanel Game Server Management Daemon",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "fs-extra": "^11.2.0",
    "multer": "^1.4.5-lts.1",
    "ws": "^8.16.0"
  }
}
EOF
fi

cd "$INSTALL_DIR"
npm install --production

# 6. Systemd Service Registration & Automatic Firewall Rules
echo "[6/6] Registering Systemd Services and UFW Firewall Rules..."

# Systemd Service: AetherPanel
cat << 'EOF' > /etc/systemd/system/aetherpanel.service
[Unit]
Description=AetherPanel Game Management Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/aetherpanel
ExecStart=/usr/bin/node /opt/aetherpanel/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production PORT=3000

[Install]
WantedBy=multi-user.target
EOF

# Systemd Service: Playit Tunnel
cat << 'EOF' > /etc/systemd/system/playit.service
[Unit]
Description=Playit.gg Tunneling Agent Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/aetherpanel
ExecStart=/usr/local/bin/playit
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Firewall Rules
if command -v ufw &> /dev/null; then
    ufw allow 3000/tcp comment 'AetherPanel Dashboard'
    ufw allow 25565/tcp comment 'Minecraft Java Default'
    ufw allow 7777/udp comment 'Terraria Default'
    ufw allow 2456:2457/udp comment 'Valheim Default'
    echo "y" | ufw enable || true
fi

# Reload and Enable Services
systemctl daemon-reload
systemctl enable aetherpanel
systemctl restart aetherpanel

systemctl enable playit
systemctl restart playit

IP_ADDR=$(hostname -I | awk '{print $1}')

echo "===================================================="
echo "    AetherPanel Installation Complete!"
echo "    Panel Status:  $(systemctl is-active aetherpanel)"
echo "    Playit Status: $(systemctl is-active playit)"
echo "    Dashboard URL: http://${IP_ADDR}:3000"
echo "===================================================="
echo "To claim your Playit.gg tunnel agent, view logs with:"
echo "sudo journalctl -u playit -n 20 --no-pager"
echo "===================================================="
