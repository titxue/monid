import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { compileBundle } from "@shared/compiler";
import {
    type Bundle,
    defineEndpoint,
    defineProvider,
    presets,
    UsageModelKind,
} from "@shared/core";
import {
    directTransport,
    Engine,
    ENGINE_VERSION,
} from "@monid/connector-engine";
import { Client } from "@mcp/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@mcp/sdk/client/streamableHttp.js";
import { Catalog } from "./catalog.ts";
import { createHandler } from "./http.ts";
import { RunManager, RunStore } from "./runs.ts";

let fixtureBundle: Promise<Bundle> | undefined;
function bundle() {
    fixtureBundle ??= compileBundle([{
        provider: defineProvider({
            name: "fixture",
            meta: { displayName: "Fixture", summary: "Test provider" },
            auth: { inject: presets.auth.header("x-api-key") },
            request: { baseUrl: "https://provider.test" },
            usage: { model: { kind: UsageModelKind.FREE }, credits: {} },
        }),
        endpoints: [
            {
                name: "sync",
                def: defineEndpoint({
                    meta: {
                        displayName: "Twitter search",
                        summary: "Search twitter tweets",
                    },
                    request: { method: "POST", path: "/sync" },
                    input: {
                        schema: { body: z.object({ message: z.string() }) },
                    },
                }),
            },
            ...["async", "slow", "timeout", "unresolved"].map((name) => ({
                name,
                def: defineEndpoint({
                    meta: { displayName: name, summary: "Async fixture" },
                    request: { method: "POST", path: `/${name}` },
                    timeouts: {
                        requestMs: 1000,
                        runMs: name === "timeout" ? 20 : 10_000,
                        pollMs: name === "slow" ? 5000 : 10,
                    },
                    lifecycle: {
                        start: async ({ utils }) => {
                            const response = await utils.request();
                            if (response.status >= 400) {
                                return {
                                    kind: "COMPLETED",
                                    httpStatus: response.status,
                                    output: response.body,
                                };
                            }
                            return {
                                kind: "RUNNING",
                                state: { externalRunId: "fixture-job" },
                            };
                        },
                        poll: async ({ data, utils }) => {
                            const response = await utils.http({
                                method: "GET",
                                url: data.request.url + "/status",
                            });
                            if (
                                utils.json.optionalGet(
                                    response.body,
                                    "$.running",
                                ) === true
                            ) return { kind: "RUNNING" };
                            return {
                                kind: "COMPLETED",
                                httpStatus: response.status,
                                output: response.body,
                            };
                        },
                        stop: async ({ data, utils }) => {
                            const response = await utils.http({
                                method: "POST",
                                url: data.request.url + "/stop",
                            });
                            if (
                                utils.json.optionalGet(
                                    response.body,
                                    "$.unresolved",
                                ) === true
                            ) {
                                return {
                                    kind: "UNRESOLVED",
                                    reason: "Needs vendor reconciliation",
                                };
                            }
                        },
                    },
                }),
            })),
        ],
    }], {
        compilerVersion: "0.1.0",
        builtWithEngineVersion: ENGINE_VERSION,
        catalogVersion: "test",
        generatedAt: new Date(0).toISOString(),
        leafCategories: [],
    });
    return fixtureBundle;
}

async function setup(
    options: {
        configured?: boolean;
        providerStatus?: number;
        directory?: string;
        fetch?: typeof fetch;
    } = {},
) {
    const calls: string[] = [];
    const mockFetch: typeof fetch = options.fetch ?? ((request, init) => {
        assertEquals(
            new Headers(init?.headers).get("x-api-key"),
            "provider-test-only",
        );
        const url = String(request);
        calls.push(url);
        if (url.includes("unresolved/stop")) {
            return Promise.resolve(Response.json({ unresolved: true }));
        }
        if (/\/(slow|timeout|unresolved)\/status$/.test(url)) {
            return Promise.resolve(Response.json({ running: true }));
        }
        return Promise.resolve(
            Response.json({ value: "fixture output" }, {
                status: options.providerStatus ?? 200,
            }),
        );
    });
    const catalog = new Catalog(
        await bundle(),
        new Engine({
            transport: directTransport({
                params: () => Promise.resolve({ apiKey: "provider-test-only" }),
                fetch: mockFetch,
            }),
        }),
        () => options.configured !== false,
    );
    const directory = options.directory ??
        await Deno.makeTempDir({ prefix: "monid-gateway-test-" });
    const store = new RunStore(directory);
    const runs = new RunManager(catalog, store);
    await runs.initialize();
    const handler = createHandler({
        catalog,
        runs,
        apiKey: "gateway-test-only",
    });
    const request = (
        path: string,
        body?: unknown,
        headers: Record<string, string> = {},
    ) => handler(
        new Request(`http://127.0.0.1${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: "Bearer gateway-test-only", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
    return {
        catalog,
        store,
        runs,
        calls,
        directory,
        handler,
        request,
        close: async () => {
            await runs.close();
            await Deno.remove(directory, { recursive: true });
        },
    };
}

Deno.test("HTTP authentication, origin, search, inspect, input validation and credential isolation", async () => {
    const app = await setup();
    try {
        assertEquals(
            (await app.handler(new Request("http://127.0.0.1/v1/providers")))
                .status,
            401,
        );
        assertEquals(
            (await app.request("/v1/providers", undefined, {
                origin: "https://other.test",
            })).status,
            403,
        );
        assertEquals(
            (await app.handler(new Request("http://127.0.0.1/healthz"))).status,
            200,
        );
        const discovered =
            await (await app.request("/v1/discover", { query: "推特" })).json();
        assertEquals(discovered.results[0].id, "fixture#sync");
        const inspected = await (await app.request("/v1/inspect", {
            provider: "fixture",
            endpoint: "/sync",
        })).json();
        assertEquals(inspected.credentialEnvVars, [
            "FIXTURE_CREDENTIALS_API_KEY",
        ]);
        assert(!JSON.stringify(inspected).includes("provider-test-only"));
        assertEquals(
            (await app.request("/v1/run", {
                id: "fixture#sync",
                input: { body: {} },
            })).status,
            400,
        );
        assertEquals(app.calls.length, 0);
        assertEquals((await app.request("/v1/runs?limit=0")).status, 400);
    } finally {
        await app.close();
    }
});

Deno.test("unconfigured providers rejected before calls; estimates remain available", async () => {
    const app = await setup({ configured: false });
    try {
        assertEquals(
            (await app.request("/v1/run", {
                id: "fixture#sync",
                input: { body: { message: "test" } },
            })).status,
            422,
        );
        assertEquals(
            (await app.request("/v1/estimate", {
                id: "fixture#sync",
                input: { body: { message: "test" } },
            })).status,
            200,
        );
        assertEquals(app.calls.length, 0);
    } finally {
        await app.close();
    }
});

Deno.test("sync engine execution persists full output and cursor history across restart", async () => {
    const app = await setup();
    try {
        const first = await app.runs.submit("fixture#sync", {
            body: { message: "test" },
        });
        await app.runs.waitForIdle(first.runId);
        const second = await app.runs.submit("fixture#sync", {
            body: { message: "again" },
        });
        await app.runs.waitForIdle(second.runId);
        const result = app.runs.get(first.runId);
        assertEquals(result.status, "COMPLETED");
        assertEquals(result.isProviderError, false);
        assertEquals(result.output, { value: "fixture output" });
        assert(
            !JSON.stringify(await app.store.readAll()).includes(
                "provider-test-only",
            ),
        );
        const page = app.runs.list(1);
        assert(page.cursor);
        assertEquals(app.runs.list(1, page.cursor).items.length, 1);
        await app.runs.close();
        const recovered = new RunManager(app.catalog, app.store);
        await recovered.initialize();
        assertEquals(recovered.get(first.runId).output, result.output);
        await recovered.close();
    } finally {
        await app.close();
    }
});

Deno.test("COMPLETED provider error stays distinct from successful output", async () => {
    const app = await setup({ providerStatus: 429 });
    try {
        const run = await app.runs.submit("fixture#sync", {
            body: { message: "test" },
        });
        await app.runs.waitForIdle(run.runId);
        const result = app.runs.get(run.runId);
        assertEquals(result.status, "COMPLETED");
        assertEquals(result.isProviderError, true);
        assertEquals(result.providerResponse?.httpStatus, 429);
        assertEquals(result.usage?.credits, {});
    } finally {
        await app.close();
    }
});

Deno.test("large scraping outputs are persisted without KV-size truncation", async () => {
    const output = { text: "x".repeat(100_000) };
    const app = await setup({
        fetch: () => Promise.resolve(Response.json(output)),
    });
    try {
        const run = await app.runs.submit("fixture#sync", {
            body: { message: "large" },
        });
        await app.runs.waitForIdle(run.runId);
        assertEquals(app.runs.get(run.runId).output, output);
        assertEquals((await app.store.readAll())[0].result?.output, output);
    } finally {
        await app.close();
    }
});

Deno.test("resource-bound endpoints are rejected before any provider request", async () => {
    const app = await setup();
    try {
        const original = app.catalog.bundle.endpoints["fixture#sync"];
        const resourceCatalog = new Catalog(
            {
                ...app.catalog.bundle,
                endpoints: {
                    ...app.catalog.bundle.endpoints,
                    "fixture#sync": {
                        ...original,
                        resources: { reads: [{ id: "fixture/account" }] },
                    },
                },
            },
            new Engine({
                transport: directTransport({
                    fetch: () => {
                        throw new Error(
                            "Resource execution must not reach the provider",
                        );
                    },
                }),
            }),
            () => true,
        );
        const runs = new RunManager(resourceCatalog, app.store);
        await runs.initialize();
        assertEquals(resourceCatalog.inspect("fixture#sync").supported, false);
        await assertRejects(() =>
            runs.submit("fixture#sync", { body: { message: "test" } })
        );
        await runs.close();
        assertEquals(app.calls.length, 0);
    } finally {
        await app.close();
    }
});

Deno.test("async polling, upstream stop, timeout and unresolved teardown", async () => {
    const app = await setup();
    try {
        const asyncRun = await app.runs.submit("fixture#async", {});
        await app.runs.waitForIdle(asyncRun.runId);
        assertEquals(app.runs.get(asyncRun.runId).status, "COMPLETED");
        const slow = await app.runs.submit("fixture#slow", {});
        await app.runs.stop(slow.runId);
        await app.runs.waitForIdle(slow.runId);
        assertEquals(app.runs.get(slow.runId).status, "STOPPED");
        assert(app.calls.some((url) => url.endsWith("/slow/stop")));
        const timeout = await app.runs.submit("fixture#timeout", {});
        await app.runs.waitForIdle(timeout.runId);
        assertEquals(app.runs.get(timeout.runId).status, "TIMED_OUT");
        const unresolved = await app.runs.submit("fixture#unresolved", {});
        await app.runs.stop(unresolved.runId);
        await app.runs.waitForIdle(unresolved.runId);
        assertEquals(app.runs.get(unresolved.runId).status, "UNRESOLVED");
        await assertRejects(() => app.runs.stop(asyncRun.runId));
    } finally {
        await app.close();
    }
});

Deno.test("parked async state resumes after restart without duplicate start", async () => {
    const app = await setup();
    try {
        const run = await app.runs.submit("fixture#slow", {});
        await app.runs.close();
        assertEquals(
            app.calls.filter((url) => url.endsWith("/slow")).length,
            1,
        );
        const recovered = new RunManager(app.catalog, app.store);
        await recovered.initialize();
        await recovered.stop(run.runId);
        await recovered.waitForIdle(run.runId);
        assertEquals(recovered.get(run.runId).status, "STOPPED");
        assertEquals(
            app.calls.filter((url) => url.endsWith("/slow")).length,
            1,
        );
        await recovered.close();
    } finally {
        await app.close();
    }
});

Deno.test("interrupted start is recorded without automatically repeating upstream work", async () => {
    const app = await setup();
    try {
        const row = {
            runId: crypto.randomUUID(),
            endpointId: "fixture#async",
            connectorHash: app.catalog.get("fixture#async").hash,
            input: {},
            status: "STARTING" as const,
            createdAt: new Date().toISOString(),
            deadline: Date.now() + 10000,
            estimatedUsage: { credits: {}, evidence: {} },
        };
        await app.store.save(row);
        const recovered = new RunManager(app.catalog, app.store);
        await recovered.initialize();
        assertEquals(recovered.get(row.runId).status, "FAILED");
        assertEquals(app.calls.length, 0);
        await recovered.close();
    } finally {
        await app.close();
    }
});

Deno.test("unfinished runs from a provider removed by the allowlist do not break startup", async () => {
    const app = await setup();
    try {
        const run = await app.runs.submit("fixture#slow", {});
        await app.runs.close();
        const restricted = new Catalog(
            app.catalog.bundle,
            new Engine({ transport: directTransport() }),
            () => true,
            new Set(["other"]),
        );
        const recovered = new RunManager(restricted, app.store);
        await recovered.initialize();
        assertEquals(recovered.get(run.runId).status, "FAILED");
        assertEquals(
            app.calls.filter((url) => url.endsWith("/slow")).length,
            1,
        );
        await recovered.close();
    } finally {
        await app.close();
    }
});

Deno.test("official MCP client initializes, lists tools and discovers/executes a fixture", async () => {
    const app = await setup();
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    try {
        await client.connect(
            new StreamableHTTPClientTransport(
                new URL("http://127.0.0.1/mcp"),
                {
                    requestInit: {
                        headers: { authorization: "Bearer gateway-test-only" },
                    },
                    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
                        app.handler(new Request(input, init)),
                },
            ),
        );
        assertEquals((await client.listTools()).tools.length, 7);
        const discovery = await client.callTool({
            name: "discover",
            arguments: { query: "twitter" },
        });
        assertEquals(discovery.isError, undefined);
        const submitted = await client.callTool({
            name: "run",
            arguments: {
                id: "fixture#sync",
                input: { body: { message: "MCP" } },
            },
        });
        const content = submitted.content as { type: string; text: string }[];
        const run = JSON.parse(content[0].text);
        await app.runs.waitForIdle(run.runId);
        const response = await client.callTool({
            name: "get_run",
            arguments: { runId: run.runId },
        });
        assertEquals(
            JSON.parse((response.content as { text: string }[])[0].text).status,
            "COMPLETED",
        );
    } finally {
        await client.close();
        await app.close();
    }
});
