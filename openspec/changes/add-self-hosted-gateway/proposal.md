# Self-hosted tool gateway

Expose the existing connector catalog and engine through a small, single-user
HTTP service and MCP endpoint. Use operator-owned provider credentials and
persist run history locally. Ship a browser console and Docker Compose setup.

The gateway is an independent host; it does not change the connector ABI,
compiler, or engine. Hosted Monid wallets, OAuth, semantic routing, recurring
resources, and multi-tenant billing are outside this first version.
