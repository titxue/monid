# Design

## D1 — Reuse the engine as a host

Load the compiled bundle and seal each endpoint before execution. Credentials
are resolved by directTransport from the existing provider environment-variable
convention. Resource-bound endpoints are listed as unsupported and rejected
before execution: this host does not manage recurring resources or webhooks.

## D2 — Single process, durable runs

Store each run as an atomically replaced JSON file under .output/gateway/runs.
This avoids Deno KV's small value limit for scraping outputs. Drive start/poll/
stop sequentially with one stable run ID. Persist each async state before the
next poll. Resume parked runs after restart, only when the connector hash still
matches. An interrupted start has no reliable upstream handle; record it as
FAILED and never automatically submit it again. Stop requests interrupt sleep,
but wait for in-flight phases to finish before upstream teardown.

All submissions return a run ID immediately (HTTP 202), including synchronous
providers. The result retains isProviderError separately from lifecycle status.
Stop outcomes that require reconciliation remain UNRESOLVED, never advertised
as successfully stopped. Provider units are reported as usage, not USD prices.

## D3 — Simple search and explicit availability

Rank endpoint names, IDs, descriptions, and categories with local token matching.
Support provider/category filters and configured-credentials-only discovery.
No model dependency or external Monid account is required. Inspection reports
input/output schemas, credential VARIABLE NAMES, execution support, and the
vendor-native usage model. It never returns credential values.

## D4 — HTTP and MCP share the service

Use Deno.serve and the official MCP SDK's stateless Web Standard Streamable HTTP
transport at /mcp. Both surfaces call the same catalog and run manager. Protect
them with one required Bearer API key, reject browser origins from other hosts,
bind local execution to loopback by default, and expose Compose on loopback.
The unauthenticated root console and health endpoint contain no catalog or run
data. The console keeps its token in memory only.

## D5 — Deployment and verification

Build a catalog into a pinned Deno Docker image and persist only .output/gateway
in a named volume. Verify engine-backed sync and async flows with injected
provider fetch fixtures, including credential injection, schema rejection,
provider errors, restart recovery, timeout/stop, and MCP tool calls. Run the
upstream checks and build/start the actual Compose service.
