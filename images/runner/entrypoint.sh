#!/bin/sh
Xvfb :99 -screen 0 1280x720x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
i=0
while [ "$i" -lt 25 ]; do
  if [ -e /tmp/.X99-lock ]; then
    break
  fi
  i=$((i + 1))
  sleep 0.2
done
export DISPLAY=:99
exec node /opt/runner/main.js
