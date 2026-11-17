# Xiaohongshu browser image

The Xiaohongshu backend in `@nite07/search-core` reads the site through a browser, because the site
serves its data only to its own page runtime: a plain fetch is refused, and the operations need the
page's client. This image is that browser, packaged so nothing has to be assembled by hand.

## What is inside

| Piece | Why |
| --- | --- |
| Patchright + Google Chrome | Patchright is a Playwright fork that closes the CDP leaks detection systems look for (it avoids `Runtime.enable`, disables `Console.enable`, drops `--enable-automation`). It drives a real Google Chrome, the build its authors recommend. Chosen over remote debugging, which leaks automation to the page, and over licensed stealth builds, which need a key. |
| Playwright server (`wsPath=/xhs`) | The endpoint another process attaches to. Fixed path, so the URL survives a restart. Chrome is baked into the image, so a restart never waits on a download. |
| Token proxy on `:3000` | Playwright has no authentication beyond an unguessable path; a fixed path is guessable, so the proxy requires `Authorization: Bearer <token>` and forwards only authorised upgrades. |
| Xvfb + x11vnc + noVNC on `:6080` | You sign in to Xiaohongshu once, by QR code, in a real window. Works on a headless server. |
| `/profile` volume | Holds `state.json` (cookies) and `ws-token`, so both the login and the endpoint token survive a restart. |

## Run it

```sh
podman compose up -d --build
podman logs xhs-browser      # prints the endpoint and the bearer token
```

Compose takes the password, token and published ports from the shell or from a `.env` file beside
`compose.yaml`. `env.example` lists every variable with its default:

```sh
cp env.example .env && chmod 600 .env   # then edit it
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `XHS_BIND_ADDR` | `127.0.0.1` | Address the ports are bound to; set it when another machine must reach them |
| `XHS_ENDPOINT_PORT` | `3000` | Host port for the Playwright endpoint |
| `XHS_VNC_PORT` | `6080` | Host port for noVNC |
| `XHS_VNC_PASSWORD` | empty | VNC password; required as soon as the port is not loopback |
| `XHS_WS_TOKEN` | empty | Endpoint token; generated on first start when empty |

Without compose, the equivalent is one `podman build` and one `podman run` with the same ports,
volume and `--shm-size=1gb`.

A named volume keeps the login with the container. Use a bind mount instead when the search core
runs on the same host and must read the session file: replace the volume line with
`- /path/to/data:/profile:Z`.

## Publishing the image

`.github/workflows/image.yml` builds and pushes two copies of the same image:

- `docker.io/<DOCKERHUB_USERNAME>/xhs-playwright`
- `ghcr.io/<owner>/xhs-playwright`

Two secrets are needed in the repository settings: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (an
access token with read/write scope, not the account password). GHCR uses the workflow's own
`GITHUB_TOKEN`, so it needs no extra secret.

| Trigger | What it does |
| --- | --- |
| Push a tag `xhs-v<version>` | Publishes `<version>`, `<major>.<minor>`, `<major>` and `latest`. The version should match the Patchright driver inside the image, so `xhs-v1.64.3` means "this image carries driver 1.64.3". |
| Manual run | Rebuilds the current commit and publishes it as `latest` plus `sha-<short>`, optionally with an extra tag and optionally for `linux/arm64` as well. Untick "publish" to only build. |
| Pull request touching `image/` | Builds without publishing, so a broken Dockerfile fails the pull request instead of the release. |

```sh
git tag -a xhs-v1.64.3 -m "image: patchright 1.64.3"
git push origin xhs-v1.64.3
```

Bump `ARG PATCHRIGHT_VERSION` and `image/package.json` together before tagging: the driver in the
image and the client in the search core must be the same major.minor, or the Playwright server
refuses the connection.

## Sign in once

The container keeps a sign-in window open on its display, so there is nothing to start by hand:

1. Open `http://<host>:6080/vnc.html` and connect with `XHS_VNC_PASSWORD`.
2. Xiaohongshu is already loaded in that window; sign in with the QR code.
3. The keeper notices the session and writes `/profile/state.json`; it refreshes it while the
   session stays valid.

After that the session is reused on every start. Nothing in the search core can sign in, and no
credential ever leaves the container.

If the window ever closes, restart the container: the keeper reopens it.

Two deployment notes, both learned the hard way:

- In rootless mode a plain `podman restart` can bring the container back healthy with its published
  address unbound, which looks like a dead endpoint from every client. Recreate instead, either with
  `podman compose up -d --force-recreate` or by restarting whatever unit owns the container.
- The search core reads `~/.config/dsh-search/xhs/state.json` by default. When the profile is a
  bind mount, point that path at it with a symlink or set the backend's `statePath` option; the
  container only ever writes inside the mounted directory.

## Publishing it beyond loopback

A remote machine needs the ports bound to an address it can reach, for example a tailnet address:

```sh
podman run -d --restart unless-stopped --name xhs-browser \
  -p 100.64.0.10:3030:3000 -p 100.64.0.10:6080:6080 \
  -v ~/pod/xhs-browser/data:/profile:Z --shm-size=1gb xhs-playwright
```

Bind the VNC port only where you trust the network, and set a password whenever it is not loopback:
anything that can reach it and knows no password can drive the browser. The Playwright endpoint
always requires its bearer token.

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

`patchright` here and `patchright-core` in `@nite07/search-core` must share a major.minor —
Playwright's protocol requires it, and a mismatch answers `428 Precondition Required`. Both are
pinned to `1.64.3`; bump them together, and rebuild the image in the same commit.

## One honest limitation

Patchright's stealth rests on executing page JavaScript in an isolated execution context, where
detection cannot see it. Xiaohongshu reads cannot use that: this backend needs the page's own
webpack runtime, which lives in the main world, so the read calls pass
`isolatedContext: false`. Stealth still covers navigation, the browser's command-line surface and
the protocol handshake — but the evaluate calls themselves are not hidden. Reads only, no clicking
or typing, which is why that trade is acceptable here.

## Operations

- **Browser crashed or the page is stuck**: `systemctl --user restart xhs-browser`. The profile survives.
- **Signed out of Xiaohongshu**: sign in again over VNC; the next save updates the volume.
- **Token rotated**: delete `/profile/ws-token` (or set `XHS_WS_TOKEN`) and restart; update the core's credential.
- **Wiped volume**: both the login and the token are gone; sign in again and copy the new token.
