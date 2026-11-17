# Xiaohongshu browser for @nite07/search-core.
#
# One container provides everything the read backend needs: a stealth Chromium (CloakBrowser),
# a virtual display, a VNC surface to sign in once, a Playwright server endpoint, and a token
# check in front of that endpoint. The login lives in the mounted profile volume.
#
#   docker build -t xhs-playwright .
#   docker run -d -p 127.0.0.1:3000:3000 -p 127.0.0.1:6080:6080 -v xhs-profile:/profile xhs-playwright
#   docker logs xhs-playwright        # prints the ws endpoint and the token
#
FROM cloakhq/cloakbrowser:latest

# Playwright is the client-side protocol implementation; the browser itself is CloakBrowser's
# binary. The version is pinned here and must match playwright-core in @nite07/search-core:
# the server and client share a major.minor.
ARG PLAYWRIGHT_VERSION=1.65.1

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      x11vnc novnc websockify tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/xhs-bridge /profile

WORKDIR /opt/xhs-bridge
COPY package.json launcher.mjs ws-proxy.mjs entrypoint.sh /opt/xhs-bridge/
RUN npm install --omit=dev --no-audit --no-fund \
    && chmod +x /opt/xhs-bridge/entrypoint.sh

# Find the stealth Chromium once, at build time, so startup does not scan the filesystem.
RUN set -eux; \
    binary="$(find / -xdev -type f \( -name chrome -o -name chromium \) -perm -u+x 2>/dev/null | head -n 1)"; \
    test -n "$binary"; \
    echo "$binary" > /opt/xhs-bridge/chromium-path; \
    "$binary" --version

ENV DISPLAY=:99 \
    XHS_INTERNAL_PORT=3001 \
    XHS_PUBLIC_PORT=3000 \
    XHS_VNC_PORT=6080 \
    XHS_PROFILE_DIR=/profile \
    XHS_WS_PATH=/xhs

EXPOSE 3000 6080
VOLUME ["/profile"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/xhs-bridge/entrypoint.sh"]
