FROM node:22-bookworm-slim
WORKDIR /opt/proxy
COPY packages/controller/dist/egress-proxy.js /opt/proxy/egress-proxy.js
ENV AEGIS_PROXY_MAIN=1
USER node
EXPOSE 8888
CMD ["node", "/opt/proxy/egress-proxy.js"]
