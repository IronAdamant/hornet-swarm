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
COPY images/runner/browser-launch /opt/runner/browser-launch
# Files an `upload` step can attach, by name: sample.txt, sample.png, sample.pdf.
COPY images/runner/fixtures /opt/runner/fixtures

RUN groupadd --gid 10010 control \
    && groupadd --gid 10002 browsers \
    && useradd --create-home --uid 10001 --gid 10010 --shell /usr/sbin/nologin runner \
    && useradd --create-home --uid 10002 --gid 10002 --shell /usr/sbin/nologin browser \
    && mkdir -p /home/runner/profile \
    && chmod 755 /opt/runner/entrypoint.sh /opt/runner/browser-launch \
    && chown -R runner:control /home/runner /opt/runner \
    && chown -R browser:browsers /home/browser

# Root only until entrypoint.sh drops to the runner user.
USER root
ENV HOME=/home/runner \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config

EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/runner/entrypoint.sh"]
