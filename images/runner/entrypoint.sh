#!/bin/sh
# Docker starts this as root so SETUID, SETGID, and SETPCAP stay effective.
# Node runs as the runner user. browser-launch drops Chrome to the browser user.
set -eu
drop='setpriv --reuid=10001 --regid=10010 --clear-groups --inh-caps=+setuid,+setgid,+setpcap --ambient-caps=+setuid,+setgid,+setpcap --'
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
$drop Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
i=0
while [ "$i" -lt 50 ]; do
  if [ -S /tmp/.X11-unix/X99 ]; then
    break
  fi
  i=$((i + 1))
  sleep 0.2
done
if [ ! -S /tmp/.X11-unix/X99 ]; then
  echo "Xvfb did not start" >&2
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi
# The X socket belongs to the runner. This root process has no CAP_FOWNER, so the owner changes it.
$drop chmod 0777 /tmp/.X11-unix/X99
export DISPLAY=:99
export AEGIS_BROWSER_USER=browser
export AEGIS_BROWSER_LAUNCH=/opt/runner/browser-launch
# Linux Docker keeps the host uid on a bind mount, so the runner user cannot read a
# host-owned mode-0600 token. Root opens it here. setpriv keeps the descriptor, and a
# pre-set AEGIS_CONTROL_TOKEN_FD is replaced so only this descriptor is used.
if [ -z "${AEGIS_CONTROL_TOKEN_FILE:-}" ]; then
  echo "hornet-swarm-runner needs AEGIS_CONTROL_TOKEN_FILE." >&2
  exit 1
fi
if ! exec 3<"$AEGIS_CONTROL_TOKEN_FILE"; then
  echo "hornet-swarm-runner could not open the control token file." >&2
  exit 1
fi
export AEGIS_CONTROL_TOKEN_FD=3
exec $drop node /opt/runner/main.js
