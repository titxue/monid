import { join } from "@std/path";
import { zBundle } from "@shared/core";
import { directTransport, Engine } from "@monid/connector-engine";
import { compileToOutput } from "../scripts/lib.ts";
import { Catalog } from "./catalog.ts";
import { createHandler } from "./http.ts";
import { RunManager, RunStore } from "./runs.ts";

export async function startGateway() {
    const apiKey = Deno.env.get("GATEWAY_API_KEY") ?? "";
    if (!apiKey.trim() || apiKey === "replace-with-a-long-random-key") {
        throw new Error(
            "Set a non-placeholder GATEWAY_API_KEY in .env before starting the gateway.",
        );
    }
    const catalogPath = Deno.env.get("GATEWAY_CATALOG_PATH");
    const bundle = catalogPath
        ? zBundle.parse(JSON.parse(await Deno.readTextFile(catalogPath)))
        : (await compileToOutput()).bundle;
    const providers = Deno.env.get("GATEWAY_ALLOWED_PROVIDERS");
    const catalog = new Catalog(
        bundle,
        new Engine({ transport: directTransport() }),
        undefined,
        providers?.trim()
            ? new Set(
                providers.split(",").map((name) => name.trim()).filter(Boolean),
            )
            : undefined,
    );
    const runs = new RunManager(
        catalog,
        new RunStore(
            join(Deno.env.get("GATEWAY_DATA_DIR") ?? ".output/gateway", "runs"),
        ),
    );
    await runs.initialize();
    const consoleHtml = await Deno.readTextFile(
        new URL("./console.html", import.meta.url),
    );
    const hostname = Deno.env.get("GATEWAY_HOST") ?? "127.0.0.1";
    const port = Number(Deno.env.get("GATEWAY_PORT") ?? 8787);
    const server = Deno.serve(
        { hostname, port },
        createHandler({ catalog, runs, apiKey, consoleHtml }),
    );
    let closing = false;
    const shutdown = async () => {
        if (closing) return;
        closing = true;
        await runs.close();
        await server.shutdown();
    };
    Deno.addSignalListener("SIGTERM", () => void shutdown());
    Deno.addSignalListener("SIGINT", () => void shutdown());
    console.error(
        `[gateway] ${
            Object.keys(bundle.endpoints).length
        } catalog endpoints; console at http://${hostname}:${port}; MCP at /mcp`,
    );
    return { server, runs, shutdown };
}

if (import.meta.main) await startGateway();
