# Xiaohongshu browser image

The Xiaohongshu backend in `@nite07/search-core` reads the site through a browser, because the site
serves its data only to its own page runtime: a plain fetch is refused, and the operations need the
page's client. This image is that browser, packaged so nothing has to be assembled by hand.

## What is inside

| Piece | Why |
| --- | --- |
| CloakBrowser stealth Chromium | A real Chromium with source-level fingerprint patches, so the site sees a normal browser. Chosen over automation-flagged builds and over remote debugging, which leaks automation to the page. |
| Playwright server (`wsPath=/xhs`) | The endpoint another process attaches to. Fixed path, so the URL survives a restart. |
| Token proxy on `:3000` | Playwright has no authentication beyond an unguessable path; a fixed path is guessable, so the proxy requires `Authorization: Bearer <token>` and forwards only authorised upgrades. |
| Xvfb + x11vnc + noVNC on `:6080` | You sign in to Xiaohongshu once, by QR code, in a real window. Works on a headless server. |
| `/profile` volume | Holds `state.json` (cookies) and `ws-token`, so both the login and the endpoint token survive a restart. |

## Run it

```sh
podman build -t xhs-playwright .
podman run -d --name xhs-browser \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:6080:6080 \
  -v xhs-profile:/profile --shm-size=1gb \
  xhs-playwright
podman logs xhs-browser      # prints the endpoint and the bearer token
```

On a systemd host, the included `xhs-browser.container` quadlet is the better fit:

```sh
mkdir -p ~/.config/containers/systemd
cp xhs-browser.container ~/.config/containers/systemd/
podman volume create xhs-profile      # only if it does not exist yet
systemctl --user daemon-reload && systemctl --user start xhs-browser
journalctl --user -u xhs-browser -n 50 | grep -E 'endpoint|token'
```

`podman-compose up -d` with `compose.yaml` also works.

## Sign in once

1. Open `http://<host>:6080/vnc.html`, connect.
2. In that window, open `xiaohongshu.com` and sign in with the QR code.
3. The launcher saves cookies to `/profile/state.json` every minute and on shutdown.

After that the session is reused on every start. Nothing in the search core can sign in, and no
credential ever leaves the container.

## Point the search core at it

Backend `xiaohongshu`, then:

| Field | Value |
| --- | --- |
| Endpoint | `ws://127.0.0.1:3000/xhs` |
| Credential | the bearer token from `podman logs xhs-browser` |

Environment equivalents for hosts without a settings page: `XHS_WS_ENDPOINT`, `XHS_WS_TOKEN`.

## Endpoint exposure

The token is the whole access control. Keep the port on loopback, or put it on a private network;
anyone who can reach the endpoint and holds the token can drive the browser as you.

## Version pinning

`playwright-core` inside this image and inside `@nite07/search-core` must share a major.minor —
Playwright's protocol requires it, and a mismatch answers `428 Precondition Required`. Both are
pinned to `1.65.1`; bump them together.

## Operations

- **Browser crashed or the page is stuck**: `systemctl --user restart xhs-browser`, or `podman restart xhs-browser`. The profile survives.
- **Signed out of Xiaohongshu**: sign in again over VNC; the next save updates the volume.
- **Token rotated**: delete `/profile/ws-token` (or set `XHS_WS_TOKEN`) and restart; update the core's credential.
- **Wiped volume**: both the login and the token are gone; sign in again and copy the new token.
