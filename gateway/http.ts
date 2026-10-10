import { z } from "zod";
import { zRunInput } from "@shared/core";
import { EngineError } from "@monid/connector-engine";
import { Catalog, GatewayError } from "./catalog.ts";
import { handleMcp, searchSchema } from "./mcp.ts";
import { RunManager } from "./runs.ts";

const selectionSchema = z.object({
    id: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
}).refine(
    (value) => !!value.id || (!!value.provider && !!value.endpoint),
    "Provide id, or provider and endpoint.",
);
const executionSchema = selectionSchema.safeExtend({
    input: zRunInput.default({}),
});
const listSchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().uuid().optional(),
});
const selectId = (value: z.infer<typeof selectionSchema>) =>
    value.id ?? `${value.provider}#${value.endpoint!.replace(/^\//, "")}`;
const json = (value: unknown, status = 200) =>
    Response.json(value, {
        status,
        headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        },
    });

export function createHandler(
    options: {
        catalog: Catalog;
        runs: RunManager;
        apiKey: string;
        consoleHtml?: string;
    },
) {
    if (!options.apiKey.trim()) {
        throw new Error("GATEWAY_API_KEY must be non-empty.");
    }
    const { catalog, runs, apiKey } = options;
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        try {
            const origin = request.headers.get("origin");
            if (origin && origin !== url.origin) {
                throw new GatewayError(
                    403,
                    "ORIGIN_DENIED",
                    "Cross-origin browser requests are not allowed.",
                );
            }
            if (request.method === "GET" && url.pathname === "/healthz") {
                return json({ status: "ok" });
            }
            if (request.method === "GET" && url.pathname === "/") {
                return new Response(
                    options.consoleHtml ?? "Monid self-hosted gateway",
                    {
                        headers: {
                            "content-type": "text/html; charset=utf-8",
                            "cache-control": "no-store",
                            "x-content-type-options": "nosniff",
                            "content-security-policy":
                                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
                        },
                    },
                );
            }
            if (request.headers.get("authorization") !== `Bearer ${apiKey}`) {
                return new Response(
                    JSON.stringify({
                        code: "UNAUTHORIZED",
                        message: "A valid gateway Bearer API key is required.",
                    }),
                    {
                        status: 401,
                        headers: {
                            "content-type": "application/json",
                            "cache-control": "no-store",
                            "www-authenticate": 'Bearer realm="monid-gateway"',
                        },
                    },
                );
            }
            if (url.pathname === "/mcp") {
                return await handleMcp(request, catalog, runs);
            }
            if (request.method === "GET" && url.pathname === "/v1/providers") {
                return json({ providers: catalog.providers() });
            }
            if (request.method === "POST" && url.pathname === "/v1/discover") {
                return json(
                    catalog.discover(searchSchema.parse(await request.json())),
                );
            }
            if (request.method === "POST" && url.pathname === "/v1/inspect") {
                return json(
                    catalog.inspect(
                        selectId(selectionSchema.parse(await request.json())),
                    ),
                );
            }
            if (
                request.method === "POST" &&
                ["/v1/run", "/v1/estimate"].includes(url.pathname)
            ) {
                const value = executionSchema.parse(await request.json());
                const id = selectId(value);
                return url.pathname === "/v1/run"
                    ? json(await runs.submit(id, value.input), 202)
                    : json(await runs.estimate(id, value.input));
            }
            if (request.method === "GET" && url.pathname === "/v1/runs") {
                const query = listSchema.parse(
                    Object.fromEntries(url.searchParams),
                );
                return json(runs.list(query.limit, query.cursor));
            }
            const match = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/stop)?$/);
            if (match) {
                const runId = z.string().uuid().parse(match[1]);
                if (request.method === "POST" && match[2]) {
                    return json(await runs.stop(runId), 202);
                }
                if (request.method === "GET" && !match[2]) {
                    return json(runs.get(runId));
                }
            }
            throw new GatewayError(404, "NOT_FOUND", "Route not found.");
        } catch (error) {
            if (error instanceof GatewayError) {
                return json(
                    { code: error.code, message: error.message },
                    error.status,
                );
            }
            if (error instanceof z.ZodError) {
                return json({
                    code: "INVALID_INPUT",
                    message: "Request does not match the input schema.",
                    issues: error.issues,
                }, 400);
            }
            if (error instanceof SyntaxError) {
                return json({
                    code: "INVALID_JSON",
                    message: "Request body must be valid JSON.",
                }, 400);
            }
            if (error instanceof EngineError) {
                return json({
                    code: error.code,
                    message: error.code === "INVALID_INPUT"
                        ? "Input does not match the endpoint schema. Inspect the endpoint before running it."
                        : "Engine rejected the request. Check the endpoint configuration.",
                }, error.code === "INVALID_INPUT" ? 400 : 422);
            }
            console.error("[gateway] request failed: INTERNAL_ERROR");
            return json({
                code: "INTERNAL_ERROR",
                message: "Gateway request failed.",
            }, 500);
        }
    };
}
