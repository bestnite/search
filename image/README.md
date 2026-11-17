# Search browser image

Any backend in `@nite07/search-core` with `mode: browser` attaches to this container. Nothing inside
knows which site is being read: it is a Chrome with a virtual display, a window for a human to sign
in through, and a Playwright endpoint behind a token check. Adding another browser-backed backend
needs no image change.

## What is inside

| Piece | Why it is there |
| --- | --- |
| Patchright + Google Chrome | Patchright is a Playwright fork that closes the CDP leaks detection systems look for (it avoids `Runtime.enable`, disables `Console.enable`, drops `--enable-automation`). It drives a real Google Chrome, the build its authors recommend. Chosen over remote debugging, which leaks automation to the page, and over licensed stealth builds, which need a key. |
| Playwright server (`wsPath=/ws`) | The endpoint readers attach to. Fixed path, so the URL survives a restart. Chrome is baked into the image, so a restart never waits on a download. |
| Token proxy on `:3000` | Playwright has no authentication beyond an unguessable path; a fixed path is guessable, so the proxy requires `Authorization: Bearer <token>` and forwards only authorised upgrades. |
| Xvfb + x11vnc + noVNC on `:6080` | One browser window a person can reach on a headless server, for signing in to whatever site needs it. |
| A keeper client | A browser server shows a window only while a client is attached, so one client stays attached and the window stays open. It also writes the session to disk every minute. |
| `/profile` volume | Holds `state.json` (cookies and local storage for every site signed into) and the endpoint token. |

## Run it

```sh
podman compose up -d --build
podman logs search-browser      # prints the endpoint and the bearer token
```

Values come from this directory's `.env` (compose reads it for interpolation) or from the shell.
`env.example` lists every variable with its default and the reason for it:

```sh
cp env.example .env && chmod 600 .env   # then edit it
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_BIND_ADDR` | `127.0.0.1` | Address the ports are bound to; set it when another machine must reach them |
| `BROWSER_ENDPOINT_PORT` | `3000` | Host port for the Playwright endpoint |
| `BROWSER_VNC_PORT` | `6080` | Host port for noVNC |
| `BROWSER_VNC_PASSWORD` | empty | VNC password, at most 8 characters; required as soon as the port is not loopback |
| `BROWSER_WS_TOKEN` | empty | Endpoint token; generated on first start when empty |
| `BROWSER_START_URL` | `about:blank` | What the sign-in window opens at |

Without compose, the equivalent is one `podman build` and one `podman run` with the same ports,
volume and `--shm-size=1gb`.

A named volume keeps the session with the container. Use a bind mount instead when the search core
runs on the same host and must read the session file: replace the volume line with
`- /path/to/data:/profile:Z`.

## Sign in

The container keeps a single window open on its display, so there is nothing to start by hand:

1. Open `http://<host>:6080/vnc.html` and connect with `BROWSER_VNC_PASSWORD`.
2. Navigate that window to the site that needs a login and sign in. It is an ordinary browser, so
   every site signed into there ends up in the same cookie jar.
3. The keeper writes `/profile/state.json` every minute and on shutdown. Reads start from that file,
   which is why they come back signed in.

Nothing in the search core can sign in, and no credential leaves the container.

## Point a backend at it

```jsonc
{
  "mode": "browser",
  "endpoint": "ws://<host>:3000/ws",
  "options": { "statePath": "" }   // empty: the core's default state file
}
```

Store the endpoint token printed by the container under the fixed name `DSH_SEARCH_BROWSER_TOKEN`
in the host's credential store. The core resolves only that name for browser reads; it is not a
configuration field, and no backend-specific token is tried. Set `browser.endpoint` in the shared
configuration to use the same endpoint across backends.

Any number of backends may share this endpoint: each read opens its own browser context, so cookies
from different sites never mix, and the connection is reused across calls. The state file path is a
backend option because the core has to read the same file the container writes.

## Publishing the image

`.github/workflows/image.yml` builds and pushes two copies of the same image:

- `docker.io/<DOCKERHUB_USERNAME>/search-browser`
- `ghcr.io/<owner>/search-browser`

Two secrets are needed in the repository settings: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (an
access token with read/write scope, not the account password). GHCR uses the workflow's own
`GITHUB_TOKEN`, so it needs no extra secret.

| Trigger | What it does |
| --- | --- |
| Push a tag `browser-v<version>` | Publishes `<version>`, `<major>.<minor>`, `<major>` and `latest`. The version should match the Patchright driver inside the image, so `browser-v1.64.3` means "this image carries driver 1.64.3". |
| Manual run | Rebuilds the current commit and publishes it as `latest` plus `sha-<short>`, optionally with an extra tag and optionally for `linux/arm64` as well. Untick "publish" to only build. |
| Pull request touching `image/` | Builds without publishing, so a broken Dockerfile fails the pull request instead of the release. |

```sh
git tag -a browser-v1.64.3 -m "image: patchright 1.64.3"
git push origin browser-v1.64.3
```

Bump `ARG PATCHRIGHT_VERSION` and `image/package.json` together before tagging: the driver in the
image and the client in the search core must be the same major.minor, or the Playwright server
refuses the connection with `428 Precondition Required`.

## Two operational notes, both learned the hard way

- In rootless mode a plain `podman restart` can bring the container back healthy with its published
  address unbound, which looks like a dead endpoint from every client. Recreate instead, either with
  `podman compose up -d --force-recreate` or by restarting whatever unit owns the container.
- A restarted container keeps `/tmp`, so a stale X lock would make Xvfb refuse to start and send the
  container into a restart loop. The entrypoint removes the lock first, and the keeper restarts
  itself instead of taking the container down.
