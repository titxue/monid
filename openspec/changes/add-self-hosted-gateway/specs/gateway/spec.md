# Gateway requirements

- HTTP discover/inspect/run/list/get/stop and estimate share one catalog/engine.
- MCP exposes discover, inspect, estimate, run, get_run, list_runs, and stop_run.
- A non-empty gateway API key is required; provider secrets stay server-side.
- Run inputs use the existing body/queryParams/pathParams contract.
- History survives restart; parked async jobs resume without duplicate starts.
- Provider failure is explicit even when lifecycle status is COMPLETED.
- Unconfigured and resource-bound endpoints are rejected before upstream calls.
- Searching does not require provider credentials or a language model.
- Usage is expressed in declared vendor credit units, without invented prices.
- Docker Compose and a small browser console support local self-hosting.
