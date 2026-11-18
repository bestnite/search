# Search browser for @nite07/search-core.
#
# One container serves every backend that needs a real browser — nothing here knows which site is
# being read: Google Chrome driven by Patchright (a Playwright fork with the CDP leaks closed), a
# virtual display, a VNC window for a human to sign in once, a Playwright server endpoint, and a
# token check in front of that endpoint. The session lives in the mounted volume; the browser is
# baked in, so a restart never waits on a download.
#
#   podman build -t search-browser .
#   podman logs search-browser      # prints the endpoint and the token
#
FROM node:22-bookworm-slim

# Patchright drives Chromium-based browsers only, and Google Chrome is the build it recommends:
# `channel: chrome` starts a real Chrome, not a Chromium build with automation defaults.
ARG PATCHRIGHT_VERSION=1.64.3

ENV DEBIAN_FRONTEND=noninteractive

# Chrome's shared libraries, plus the display stack: Xvfb for a virtual screen, x11vnc and noVNC
# so a human can complete the one-time QR login on a headless server.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
      libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 libxss1 libxtst6 \
      xvfb openbox x11vnc novnc websockify tini x11-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/search-browser /profile

WORKDIR /opt/search-browser
COPY package.json launcher.mjs ws-proxy.mjs keeper.mjs entrypoint.sh /opt/search-browser/
# websockify serves /usr/share/novnc as a plain directory, and noVNC ships no index.html, so a bare
# visit to the VNC port answered with a file listing. One redirect page keeps the port's front door
# to the window a person is meant to open.
COPY index.html /usr/share/novnc/index.html
RUN npm install --omit=dev --no-audit --no-fund \
    && npx patchright install chrome \
    && chmod +x /opt/search-browser/entrypoint.sh

# Chrome lives in the image, not in the volume: its revision is tied to the driver version, so a
# runtime download would only add a failure mode where a restart cannot start.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
    DISPLAY=:99 \
    BROWSER_ENDPOINT_FILE=/tmp/browser-endpoint \
    BROWSER_PUBLIC_PORT=3000 \
    BROWSER_VNC_PORT=6080 \
    BROWSER_STATE_DIR=/profile \
    BROWSER_WS_PATH=/ws

EXPOSE 3000 6080
VOLUME ["/profile"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/search-browser/entrypoint.sh"]
