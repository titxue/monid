import { McpServer } from "@mcp/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@mcp/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { type RunInput, zRunInput } from "@shared/core";
import { type Catalog, type SearchOptions } from "./catalog.ts";
import { type RunManager } from "./runs.ts";

export const searchSchema = z.object({
    query: z.string().max(1000).default(""),
    provider: z.string().optional(),
    category: z.string().optional(),
    configuredOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(40).default(10),
}).strict();

export async function handleMcp(
    request: Request,
    catalog: Catalog,
    runs: RunManager,
): Promise<Response> {
    const server = new McpServer({
        name: "monid-self-hosted",
        version: "0.1.0",
    });
    const readOnly = {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
    };
    const result = async (action: () => unknown | Promise<unknown>) => {
        try {
            const value = await action();
            return {
                content: [{
                    type: "text" as const,
                    text: JSON.stringify(value),
                }],
            };
        } catch (error) {
            return {
                content: [{
                    type: "text" as const,
                    text: error instanceof Error
                        ? error.message
                        : "Tool call failed.",
                }],
                isError: true,
            };
        }
    };
    server.registerTool("discover", {
        description:
            "Search the local tool catalog by keywords. Returns endpoint IDs, configuration availability, and vendor usage models. Does not execute providers; prices are not denominated in USD unless the credit system says so.",
        inputSchema: searchSchema,
        annotations: readOnly,
    }, (input: SearchOptions) => result(() => catalog.discover(input)));
    server.registerTool("inspect", {
        description:
            "Inspect an endpoint's input/output schemas, usage model, notes, and required credential environment variable names. No secret values are returned.",
        inputSchema: { id: z.string().min(1) },
        annotations: readOnly,
    }, ({ id }: { id: string }) => result(() => catalog.inspect(id)));
    server.registerTool(
        "estimate",
        {
            description:
                "Validate input and estimate vendor-native usage without making a provider request. Input uses body, queryParams, and pathParams.",
            inputSchema: {
                id: z.string().min(1),
                input: zRunInput.default({}),
            },
            annotations: readOnly,
        },
        ({ id, input }: { id: string; input: RunInput }) =>
            result(() => runs.estimate(id, input)),
    );
    server.registerTool(
        "run",
        {
            description:
                "Execute a configured tool using the operator's provider credentials. May consume paid vendor credits and perform external actions. Inspect first. Returns a run ID immediately; poll get_run for output and check isProviderError.",
            inputSchema: {
                id: z.string().min(1),
                input: zRunInput.default({}),
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        ({ id, input }: { id: string; input: RunInput }) =>
            result(() => runs.submit(id, input)),
    );
    server.registerTool("get_run", {
        description:
            "Get run status, output, provider error classification, and usage. COMPLETED only means the lifecycle finished; check isProviderError.",
        inputSchema: { runId: z.string().uuid() },
        annotations: readOnly,
    }, ({ runId }: { runId: string }) => result(() => runs.get(runId)));
    server.registerTool(
        "list_runs",
        {
            description: "List recent run summaries with cursor pagination.",
            inputSchema: {
                limit: z.number().int().min(1).max(100).default(20),
                cursor: z.string().uuid().optional(),
            },
            annotations: readOnly,
        },
        ({ limit, cursor }: { limit: number; cursor?: string }) =>
            result(() => runs.list(limit, cursor)),
    );
    server.registerTool("stop_run", {
        description:
            "Request upstream teardown for a stoppable run. STOPPING is not terminal; poll get_run. UNRESOLVED requires checking the vendor manually.",
        inputSchema: { runId: z.string().uuid() },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, ({ runId }: { runId: string }) => result(() => runs.stop(runId)));
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
        return await transport.handleRequest(request);
    } finally {
        await server.close();
    }
}
