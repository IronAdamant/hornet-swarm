# Debian 12 bookworm slim (official Node 22 image) with Chromium only.
# Node's bookworm-slim image is the spec base plus the Node runtime the runner needs.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      tini \
      tesseract-ocr \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_GC=1

WORKDIR /opt/runner
COPY images/runner/package.json /opt/runner/package.json
RUN npm install --omit=dev \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /root/.npm

COPY images/runner/build/main.js /opt/runner/main.js
COPY images/runner/entrypoint.sh /opt/runner/entrypoint.sh

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner \
    && mkdir -p /home/runner/profile \
    && chmod 755 /opt/runner/entrypoint.sh \
    && chown -R runner:runner /home/runner /opt/runner

USER runner
ENV HOME=/home/runner \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config

EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/runner/entrypoint.sh"]
