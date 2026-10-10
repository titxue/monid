FROM denoland/deno:2.9.7
USER root
WORKDIR /app
COPY --chown=deno:deno . .
RUN mkdir -p /app/.output/gateway && chown -R deno:deno /app
USER deno
RUN deno cache gateway/main.ts && deno task compiler:compile
ENV GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=8787 GATEWAY_DATA_DIR=/app/.output/gateway
EXPOSE 8787
CMD ["run", "--allow-read", "--allow-write=/app/.output", "--allow-env", "--allow-net", "gateway/main.ts"]
