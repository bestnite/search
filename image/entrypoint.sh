#!/usr/bin/env bash
# Display, VNC, browser server and token proxy, in one foreground supervisor.
set -euo pipefail

: "${DISPLAY:=:99}"
: "${XHS_VNC_PORT:=6080}"
: "${XHS_RFB_PORT:=5900}"

mkdir -p /profile
log() { printf '[entrypoint] %s\n' "$*" >&2; }

# 1) Virtual display, then a window manager so a browser window is actually drawable.
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
xvfb_pid=$!
for _ in $(seq 1 50); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.1; done
openbox --sm-disable >/dev/null 2>&1 &
wm_pid=$!

# 2) VNC: the human surface. A password is optional; without one the port must stay on loopback.
vnc_args=(-display "$DISPLAY" -forever -shared -rfbport "$XHS_RFB_PORT" -noxdamage)
if [[ -n "${XHS_VNC_PASSWORD:-}" ]]; then
  x11vnc "${vnc_args[@]}" -passwd "$XHS_VNC_PASSWORD" -bg -o /tmp/x11vnc.log
else
  x11vnc "${vnc_args[@]}" -nopw -bg -o /tmp/x11vnc.log
  log 'no XHS_VNC_PASSWORD: VNC is passwordless, so publish it on 127.0.0.1 only'
fi
websockify --web /usr/share/novnc "$XHS_VNC_PORT" "127.0.0.1:$XHS_RFB_PORT" &
novnc_pid=$!

# 3) The browser, then the token proxy in front of it.
rm -f "${XHS_ENDPOINT_FILE:-/tmp/xhs-endpoint}"
node /opt/xhs-bridge/launcher.mjs &
launcher_pid=$!
node /opt/xhs-bridge/ws-proxy.mjs &
proxy_pid=$!

cat >&2 <<BANNER

  Xiaohongshu browser ready
  -------------------------
  Playwright endpoint : ws://<host>:${XHS_PUBLIC_PORT:-3000}${XHS_WS_PATH:-/xhs}
  Token               : printed by [proxy] above (or XHS_WS_TOKEN)
  VNC                 : http://<host>:${XHS_VNC_PORT}/vnc.html   (sign in here once)

  Point the search core at the endpoint and token:
    endpoint: ws://127.0.0.1:${XHS_PUBLIC_PORT:-3000}${XHS_WS_PATH:-/xhs}
    credential: the token above

BANNER

# Any component dying is the container's failure; stop the rest instead of serving a half stack.
cleanup() { kill "$launcher_pid" "$proxy_pid" "$novnc_pid" "$wm_pid" "$xvfb_pid" 2>/dev/null || true; }
trap cleanup EXIT

wait -n "$launcher_pid" "$proxy_pid" "$novnc_pid" "$wm_pid" "$xvfb_pid"
log 'a component exited; shutting down'
