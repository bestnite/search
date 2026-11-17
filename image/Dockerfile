# Xiaohongshu browser for @nite07/search-core.
#
# One container provides everything the read backend needs: Google Chrome driven by Patchright
# (a Playwright fork with the CDP leaks closed), a virtual display, a VNC surface to sign in once,
# a Playwright server endpoint, and a token check in front of that endpoint. The login lives in the
# mounted profile volume; the browser is baked in, so a restart never waits on a download.
#
#   podman build -t xhs-playwright .
#   podman logs xhs-browser      # prints the endpoint and the token
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
    && mkdir -p /opt/xhs-bridge /profile

WORKDIR /opt/xhs-bridge
COPY package.json launcher.mjs ws-proxy.mjs login.mjs entrypoint.sh /opt/xhs-bridge/
RUN npm install --omit=dev --no-audit --no-fund \
    && npx patchright install chrome \
    && chmod +x /opt/xhs-bridge/entrypoint.sh

# Chrome lives in the image, not in the volume: its revision is tied to the driver version, so a
# runtime download would only add a failure mode where a restart cannot start.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
    DISPLAY=:99 \
    XHS_ENDPOINT_FILE=/tmp/xhs-endpoint \
    XHS_PUBLIC_PORT=3000 \
    XHS_VNC_PORT=6080 \
    XHS_PROFILE_DIR=/profile \
    XHS_WS_PATH=/xhs

EXPOSE 3000 6080
VOLUME ["/profile"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/xhs-bridge/entrypoint.sh"]
