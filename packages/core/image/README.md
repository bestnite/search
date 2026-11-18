# Search browser

English | [中文](README.zh.md)

[![image](https://img.shields.io/docker/v/nite07/search-browser?label=image&style=flat-square&color=2496ed)](https://hub.docker.com/r/nite07/search-browser)
[![pulls](https://img.shields.io/docker/pulls/nite07/search-browser?style=flat-square&color=2496ed)](https://hub.docker.com/r/nite07/search-browser)

The browser container behind every `browser`-mode backend in `@nite07/search-core`. Sites like
Xiaohongshu answer only their own page runtime, so they are read through a real Chrome here instead of
an HTTP endpoint.

You run it, you sign in once over VNC, and the search code attaches to it. Nothing in the image knows
which site is being read, so adding another browser-backed backend needs no image change.

## Quick start

```sh
cp env.example .env && chmod 600 .env   # then edit it
podman compose up -d --build
podman logs search-browser              # prints the endpoint and the bearer token
```

Copy the two printed values — the endpoint (`ws://<host>:<port>/ws`) and the token. You will need
both when configuring the host.

Without compose, the equivalent is one `podman build` and one `podman run` with the same ports,
volume and `--shm-size=1gb`.

## Docker

The same `compose.yaml` works with Docker; only the command name changes:

```sh
cp env.example .env && chmod 600 .env   # then edit it
docker compose up -d --build
docker logs search-browser
```

Without compose, build and run it directly:

```sh
docker build -t search-browser .

docker run -d --name search-browser \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:6080:6080 \
  -e BROWSER_VNC_PASSWORD=changeme \
  -v search-browser-state:/profile \
  --shm-size=1gb \
  search-browser

docker logs search-browser
```

`docker logs` prints the endpoint and the bearer token, the same two values the compose path prints.

Notes for Docker specifically:

- `--shm-size=1gb` is not optional. Chromium crashes on Docker's default 64 MB of shared memory, and
  the failure looks like a browser that dies mid-read rather than a container that exits.
- The image already sets `BROWSER_WS_PATH=/ws`, `BROWSER_PUBLIC_PORT=3000` and
  `BROWSER_STATE_DIR=/profile`, so a plain `docker run` needs only the ports, the volume and
  `--shm-size`. Add `-e BROWSER_VNC_PASSWORD=…` whenever the VNC port is reachable from anywhere but
  loopback, and `-e BROWSER_START_URL=https://…` to have the window open on the site directly.
- To let the host read the session file, use a bind mount instead of the named volume. On an SELinux
  host that needs the `:z`/`:Z` suffix: `-v /path/to/data:/profile:Z`.
- A prebuilt image is available as `ghcr.io/nite07/search-browser:latest`, which is what
  `compose.yaml` pulls when you skip `--build`. Swap the last line of the `docker run` command for it
  if you would rather not build locally.
- `--restart unless-stopped` matches what `compose.yaml` does; add it if you want the container back
  after a reboot.

## Sign in

The container keeps one browser window open for you, so there is nothing to start by hand:

1. Open `http://<host>:6080/vnc.html` and connect with `BROWSER_VNC_PASSWORD`.
2. Navigate that window to the site that needs a login and sign in. It is an ordinary browser, so
   every site you sign into there ends up in the same cookie jar.
3. The container writes `/profile/state.json` every minute and on shutdown. Reads start from that
   file, which is why they come back signed in.

Nothing in the search code can sign in, and no credential leaves the container.

## Connect a host

Point the DSH plugin or the MCP server at the endpoint and give it the token. In the DSH plugin:
**Settings → Web search → Backends → Shared browser**.

| Field | Value |
| --- | --- |
| Endpoint | the `ws://…/ws` value printed at startup |
| Endpoint token | the token printed at startup |
| Session file | `/path/to/data/state.json`, the host path of the `/profile` volume |
| Read timeout | leave the default unless reads time out |
| Per-site concurrent reads | 1–8, default 2; a local cap, not a site quota |

In the MCP server these are `search.browser.endpoint`, `search.browser.statePath`,
`search.browser.timeoutMs`, `search.browser.maxConcurrentReads`, plus `DSH_SEARCH_BROWSER_TOKEN` or
`credentials.browser` for the token. See the [MCP README](../../websearch-mcp/README.md).

The session file must be the one this container writes. If the host cannot read that path, every read
starts signed out.

## Configuration

Values come from this directory's `.env` (compose reads it for interpolation) or from the shell.
`env.example` lists every variable with its default and the reason for it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_BIND_ADDR` | `127.0.0.1` | Address the ports are bound to; change it when another machine must reach them |
| `BROWSER_ENDPOINT_PORT` | `3000` | Host port for the Playwright endpoint |
| `BROWSER_VNC_PORT` | `6080` | Host port for noVNC |
| `BROWSER_VNC_PASSWORD` | empty | VNC password, at most 8 characters; required as soon as the port is not loopback |
| `BROWSER_WS_TOKEN` | empty | Endpoint token; generated on first start when empty |
| `BROWSER_START_URL` | `about:blank` | What the sign-in window opens at |

A named volume keeps the session with the container. Use a bind mount instead when the search code
runs on the same host and must read the session file: replace the volume line with
`- /path/to/data:/profile:Z`.

## What is inside

Chrome with a virtual display, a window for a human to sign in through, and a Playwright endpoint
behind a token check.

| Piece | Why |
| --- | --- |
| Patchright + Google Chrome | Patchright is a Playwright fork that closes the CDP leaks detection systems look for. It drives a real Chrome, the build its authors recommend. |
| Playwright server on a fixed path | Readers attach to a stable URL that survives a restart; Chrome is baked into the image, so a restart never waits on a download. |
| Token proxy on `:3000` | Playwright has no authentication beyond an unguessable path; a fixed path is guessable, so the proxy requires `Authorization: Bearer <token>`. |
| Xvfb + x11vnc + noVNC on `:6080` | One browser window a person can reach on a headless server, for signing in. |
| A keeper client | A browser server shows a window only while a client is attached, so one client stays attached and keeps the window open. It also writes the session to disk every minute. |
| `/profile` volume | Holds `state.json` (cookies and local storage for every site signed into). |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `428 Precondition Required` when a reader attaches | The Patchright driver in the image and the client in `search-core` disagree on major.minor. Rebuild or upgrade so both match. |
| Endpoint looks dead after a restart | With rootless Podman a plain `restart` can bring the container back with its published address unbound. Recreate it instead: `podman compose up -d --force-recreate`, or restart the unit that owns the container. |
| Chrome dies mid-read, or the container exits under load | Shared memory is too small. `--shm-size=1gb` is required; Docker's default 64 MB is not enough. |
| Container restart-loops on X | A stale X lock in `/tmp` after a restart. The entrypoint removes it; make sure you are on a current image. |
| Reads come back signed out | The host is not reading the file this container writes. Check the session path. |
| VNC page will not connect | `BROWSER_VNC_PASSWORD` must be set as soon as the port is not loopback. |

## Publishing

`.github/workflows/image.yml` builds and pushes the image to Docker Hub and GHCR, tagged by the
Patchright driver version rather than by package version. Repository secrets: `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN`; GHCR uses the workflow's own `GITHUB_TOKEN`. Push a `browser-v<version>` tag to
publish, or run the workflow manually for `latest` plus `sha-<short>`.

## License

MIT.
