#!/bin/bash
# AetherPanel uninstaller. Usage: sudo bash uninstall.sh [--yes] [--keep-data]
set -u
INSTALL_DIR="/opt/aetherpanel"
SELF="$(readlink -f "$0")"
YES=0; KEEP=""; DETACHED=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --keep-data) KEEP=1 ;;
    --detached) DETACHED=1 ;;
  esac
done

if [ "$EUID" -ne 0 ]; then echo "Please run as root: sudo bash uninstall.sh"; exit 1; fi

if [ "$YES" -eq 0 ]; then
  read -r -p "This removes AetherPanel, Playit and SteamCMD. Continue? [y/N] " A < /dev/tty
  [[ "$A" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }
  if [ -z "$KEEP" ]; then
    read -r -p "Also DELETE all game servers and worlds in $INSTALL_DIR/data? [y/N] " A < /dev/tty
    [[ "$A" =~ ^[Yy]$ ]] && KEEP=0 || KEEP=1
  fi
fi
[ -z "$KEEP" ] && KEEP=0

# When started from the panel, re-launch outside the panel's service so stopping it doesn't kill us
if [ "$YES" -eq 1 ] && [ "$DETACHED" -eq 0 ] && command -v systemd-run &> /dev/null; then
  systemd-run --quiet --no-block --collect /bin/bash "$SELF" "$@" --detached
  exit 0
fi
[ "$DETACHED" -eq 1 ] && sleep 3

echo "Stopping services..."
systemctl disable --now aetherpanel playit 2> /dev/null
rm -f /etc/systemd/system/aetherpanel.service /etc/systemd/system/playit.service /etc/sudoers.d/aetherpanel
systemctl daemon-reload

echo "Removing files..."
rm -f /usr/local/bin/playit
rm -rf /opt/steamcmd
if command -v ufw &> /dev/null; then
  for r in 3000/tcp 25565/tcp 7777/udp 2456:2458/udp; do ufw delete allow "$r" > /dev/null 2>&1; done
fi

if [ "$KEEP" = "1" ]; then
  find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + 2> /dev/null
  echo "Kept $INSTALL_DIR/data (your servers and worlds)."
else
  rm -rf "$INSTALL_DIR"
  id aether &> /dev/null && userdel aether 2> /dev/null
fi

[ "$SELF" = "/usr/local/sbin/aetherpanel-uninstall" ] && rm -f "$SELF"
echo "AetherPanel has been uninstalled. (Java and other system packages were left installed.)"
