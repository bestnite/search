#!/usr/bin/env bash
# Display, VNC, browser server and token proxy, in one foreground supervisor.
set -euo pipefail

: "${DISPLAY:=:99}"
: "${BROWSER_VNC_PORT:=6080}"
: "${BROWSER_RFB_PORT:=5900}"

mkdir -p /profile
log() { printf '[entrypoint] %s\n' "$*" >&2; }

# 1) Virtual display, then a window manager so a browser window is actually drawable.
# A restart of the same container keeps /tmp, so a stale lock from the previous run would make
# Xvfb refuse to start and send the container into a restart loop.
display_number="${DISPLAY#:}"
display_number="${display_number%%.*}"
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
xvfb_pid=$!
for _ in $(seq 1 50); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.1; done
openbox --sm-disable >/dev/null 2>&1 &
wm_pid=$!

# 2) VNC: the human surface. A password is optional; without one the port must stay on loopback.
vnc_args=(-display "$DISPLAY" -forever -shared -rfbport "$BROWSER_RFB_PORT" -noxdamage)
if [[ -n "${BROWSER_VNC_PASSWORD:-}" ]]; then
  x11vnc "${vnc_args[@]}" -passwd "$BROWSER_VNC_PASSWORD" -bg -o /tmp/x11vnc.log
else
  x11vnc "${vnc_args[@]}" -nopw -bg -o /tmp/x11vnc.log
  log 'no BROWSER_VNC_PASSWORD: VNC is passwordless, so publish it on 127.0.0.1 only'
fi
websockify --web /usr/share/novnc "$BROWSER_VNC_PORT" "127.0.0.1:$BROWSER_RFB_PORT" &
novnc_pid=$!

# 3) The browser, then the token proxy in front of it.
rm -f "${BROWSER_ENDPOINT_FILE:-/tmp/browser-endpoint}"
node /opt/search-browser/launcher.mjs &
launcher_pid=$!
node /opt/search-browser/ws-proxy.mjs &
proxy_pid=$!

# The sign-in window: kept open so a human can log in over VNC at any time. It is auxiliary — a
# browser crash should reopen the window rather than take the whole container down — so it runs
# under its own restart loop and is not part of the critical set below.
(
  while true; do
    node /opt/search-browser/keeper.mjs || true
    log 'keeper exited; reopening the sign-in window in 5s'
    sleep 5
  done
) &
keeper_pid=$!

cat >&2 <<BANNER

  Search browser ready
  -------------------
  Playwright endpoint : ws://<host>:${BROWSER_PUBLIC_PORT:-3000}${BROWSER_WS_PATH:-/ws}
  Token               : printed by [proxy] above (or BROWSER_WS_TOKEN)
  VNC                 : http://<host>:${BROWSER_VNC_PORT}/vnc.html   (sign in here once)

  Point a search backend at the endpoint and token:
    endpoint: ws://127.0.0.1:${BROWSER_PUBLIC_PORT:-3000}${BROWSER_WS_PATH:-/ws}
    credential: the token above

BANNER

# Any component dying is the container's failure; stop the rest instead of serving a half stack.
cleanup() {
  kill "$keeper_pid" "$launcher_pid" "$proxy_pid" "$novnc_pid" "$wm_pid" "$xvfb_pid" 2>/dev/null || true
  rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}" 2>/dev/null || true
}
trap cleanup EXIT

wait -n "$launcher_pid" "$proxy_pid" "$novnc_pid" "$wm_pid" "$xvfb_pid"
log 'a component exited; shutting down'
