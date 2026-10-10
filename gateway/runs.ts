import { join } from "@std/path";
import {
    type RunCompleted,
    type RunInput,
    RunKind,
    type RunState,
    type Usage,
} from "@shared/core";
import { EngineError, type RunnableEndpoint } from "@monid/connector-engine";
import { Catalog, GatewayError } from "./catalog.ts";

export type RunStatus =
    | "STARTING"
    | "RUNNING"
    | "STOPPING"
    | "COMPLETED"
    | "FAILED"
    | "STOPPED"
    | "TIMED_OUT"
    | "UNRESOLVED";
export interface StoredRun {
    runId: string;
    endpointId: string;
    connectorHash: string;
    input: RunInput;
    status: RunStatus;
    createdAt: string;
    completedAt?: string;
    deadline: number;
    estimatedUsage: Usage;
    state?: RunState;
    pollAfterMs?: number;
    stopRequested?: boolean;
    result?: RunCompleted;
    error?: { code: string; message: string };
}
const activeStatuses = new Set<RunStatus>(["STARTING", "RUNNING", "STOPPING"]);

/** One process owns the directory. Serialize snapshots; scrape outputs have no KV value-size cap. */
export class RunStore {
    private readonly writes = new Map<string, Promise<void>>();
    constructor(readonly directory: string) {}

    async readAll(): Promise<StoredRun[]> {
        await Deno.mkdir(this.directory, { recursive: true });
        const rows: StoredRun[] = [];
        for await (const entry of Deno.readDir(this.directory)) {
            if (entry.isFile && entry.name.endsWith(".json")) {
                rows.push(
                    JSON.parse(
                        await Deno.readTextFile(
                            join(this.directory, entry.name),
                        ),
                    ),
                );
            }
        }
        return rows;
    }

    async save(run: StoredRun): Promise<void> {
        const snapshot = JSON.stringify(run);
        const previous = this.writes.get(run.runId) ?? Promise.resolve();
        const write = previous.catch(() => {}).then(async () => {
            const path = join(this.directory, `${run.runId}.json`);
            const temporary = `${path}.tmp`;
            await Deno.writeTextFile(temporary, snapshot, { mode: 0o600 });
            await Deno.rename(temporary, path);
        });
        this.writes.set(run.runId, write);
        try {
            await write;
        } finally {
            if (this.writes.get(run.runId) === write) {
                this.writes.delete(run.runId);
            }
        }
    }
}

interface Job {
    done: Promise<void>;
    wake?: () => void;
}

export class RunManager {
    private readonly rows = new Map<string, StoredRun>();
    private readonly jobs = new Map<string, Job>();
    private closing = false;
    constructor(readonly catalog: Catalog, private readonly store: RunStore) {}

    async initialize(): Promise<void> {
        for (const row of await this.store.readAll()) {
            this.rows.set(row.runId, row);
        }
        for (const row of this.rows.values()) {
            if (!activeStatuses.has(row.status)) continue;
            let doc;
            try {
                doc = this.catalog.get(row.endpointId);
            } catch { /* removed or no longer allowed */ }
            if (row.state && doc?.hash === row.connectorHash) {
                this.launch(row, await this.catalog.load(row.endpointId));
            } else {
                row.status = "FAILED";
                row.completedAt = new Date().toISOString();
                row.error = {
                    code: "INTERRUPTED",
                    message:
                        "Start was interrupted or connector changed. Upstream may have run; inspect the provider before submitting again.",
                };
                await this.store.save(row);
            }
        }
    }

    get(id: string) {
        const row = this.rows.get(id);
        if (!row) {
            throw new GatewayError(404, "RUN_NOT_FOUND", `Unknown run: ${id}`);
        }
        return this.present(row);
    }

    list(limit = 20, cursor?: string) {
        const rows = [...this.rows.values()].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt) ||
            b.runId.localeCompare(a.runId)
        );
        const found = cursor
            ? rows.findIndex((row) => row.runId === cursor)
            : -1;
        if (cursor && found === -1) {
            throw new GatewayError(
                400,
                "INVALID_CURSOR",
                "Unknown run cursor.",
            );
        }
        const start = cursor ? found + 1 : 0;
        const selected = rows.slice(start, start + limit);
        return {
            items: selected.map((row) => {
                const { input: _input, output: _output, ...summary } = this
                    .present(row);
                return summary;
            }),
            cursor: start + selected.length < rows.length
                ? selected.at(-1)?.runId
                : null,
        };
    }

    async estimate(id: string, input: RunInput) {
        const loaded = await this.catalog.load(id);
        return {
            endpointId: id,
            estimatedUsage: loaded.estimate(input),
            creditSystems: loaded.doc.usage.credits,
        };
    }

    async submit(id: string, input: RunInput) {
        if (this.closing) {
            throw new GatewayError(
                503,
                "SHUTTING_DOWN",
                "Gateway is shutting down.",
            );
        }
        this.catalog.assertRunnable(id);
        const loaded = await this.catalog.load(id);
        const row: StoredRun = {
            runId: crypto.randomUUID(),
            endpointId: id,
            connectorHash: loaded.doc.hash,
            input,
            status: "STARTING",
            createdAt: new Date().toISOString(),
            deadline: Date.now() + loaded.doc.timeouts.runMs,
            estimatedUsage: loaded.estimate(input),
        };
        await this.store.save(row);
        this.rows.set(row.runId, row);
        this.launch(row, loaded);
        return this.present(row);
    }

    async stop(id: string) {
        const row = this.rows.get(id);
        if (!row) {
            throw new GatewayError(404, "RUN_NOT_FOUND", `Unknown run: ${id}`);
        }
        if (
            !activeStatuses.has(row.status) ||
            !this.catalog.get(row.endpointId).lifecycle?.stop
        ) {
            throw new GatewayError(
                409,
                "NOT_STOPPABLE",
                "Run is terminal or this endpoint does not support stopping.",
            );
        }
        row.stopRequested = true;
        row.status = "STOPPING";
        await this.store.save(row);
        this.jobs.get(id)?.wake?.();
        return this.present(row);
    }

    async close(): Promise<void> {
        this.closing = true;
        for (const job of this.jobs.values()) job.wake?.();
        await Promise.all([...this.jobs.values()].map((job) => job.done));
    }

    async waitForIdle(id: string): Promise<void> {
        await this.jobs.get(id)?.done;
    }

    private present(row: StoredRun) {
        const doc = this.catalog.bundle.endpoints[row.endpointId];
        return {
            runId: row.runId,
            endpointId: row.endpointId,
            provider: doc?.provider,
            endpoint: doc?.endpoint,
            status: row.status,
            stoppable: activeStatuses.has(row.status) && !!doc?.lifecycle?.stop,
            input: row.input,
            output: row.result?.output ?? null,
            isProviderError: row.result?.isProviderError,
            providerResponse: row.result
                ? {
                    httpStatus: row.result.httpStatus,
                    upstreamHttpStatus: row.result.providerHttpStatus,
                }
                : undefined,
            estimatedUsage: row.estimatedUsage,
            usage: row.result?.usage,
            timing: row.result?.timing,
            error: row.error,
            createdAt: row.createdAt,
            completedAt: row.completedAt,
        };
    }

    private launch(row: StoredRun, loaded: RunnableEndpoint): void {
        const job: Job = { done: Promise.resolve() };
        this.jobs.set(row.runId, job);
        job.done = this.drive(row, loaded, job).catch((error) => {
            console.error(
                `[gateway] persistence/execution failed for ${row.runId}: ${
                    error instanceof EngineError ? error.code : "INTERNAL_ERROR"
                }`,
            );
        }).finally(() => this.jobs.delete(row.runId));
    }

    private async drive(
        row: StoredRun,
        loaded: RunnableEndpoint,
        job: Job,
    ): Promise<void> {
        try {
            if (!row.state) {
                const tick = await loaded.start(row.input, {
                    runId: row.runId,
                });
                if (tick.kind === RunKind.COMPLETED) {
                    await this.complete(row, tick);
                    return;
                }
                row.state = tick.state;
                row.pollAfterMs = tick.pollAfterMs;
                row.status = row.stopRequested ? "STOPPING" : "RUNNING";
                await this.store.save(row);
            }
            while (row.state) {
                if (row.stopRequested || Date.now() >= row.deadline) {
                    const timedOut = !row.stopRequested;
                    const stopped = await loaded.stop(row.input, row.state, {
                        runId: row.runId,
                    });
                    if (stopped.kind === RunKind.COMPLETED) {
                        await this.complete(row, stopped);
                        return;
                    }
                    row.status = stopped.kind === "UNRESOLVED"
                        ? "UNRESOLVED"
                        : timedOut
                        ? "TIMED_OUT"
                        : "STOPPED";
                    if (stopped.kind === "UNRESOLVED") {
                        row.state = stopped.state;
                        row.error = {
                            code: "UNRESOLVED",
                            message: stopped.reason ??
                                "Upstream stop requires manual reconciliation.",
                        };
                    }
                    row.completedAt = new Date().toISOString();
                    await this.store.save(row);
                    return;
                }
                if (this.closing) return;
                await this.sleep(
                    Math.min(
                        row.pollAfterMs ?? 2000,
                        Math.max(0, row.deadline - Date.now()),
                    ),
                    job,
                );
                if (this.closing) return;
                if (row.stopRequested || Date.now() >= row.deadline) continue;
                const tick = await loaded.poll(row.input, row.state, {
                    runId: row.runId,
                });
                if (tick.kind === RunKind.COMPLETED) {
                    await this.complete(row, tick);
                    return;
                }
                row.state = tick.state;
                row.pollAfterMs = tick.pollAfterMs;
                await this.store.save(row);
            }
        } catch (error) {
            row.status =
                error instanceof EngineError && error.code === "TIMEOUT"
                    ? "TIMED_OUT"
                    : "FAILED";
            row.error = {
                code: error instanceof EngineError
                    ? error.code
                    : "INTERNAL_ERROR",
                message:
                    "Execution failed. Check provider state before retrying; the run was not automatically resubmitted.",
            };
            row.completedAt = new Date().toISOString();
            await this.store.save(row);
        }
    }

    private async complete(
        row: StoredRun,
        result: RunCompleted,
    ): Promise<void> {
        row.result = result;
        row.status = "COMPLETED";
        row.completedAt = new Date().toISOString();
        delete row.state;
        await this.store.save(row);
    }

    private sleep(ms: number, job: Job): Promise<void> {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                job.wake = undefined;
                resolve();
            };
            const timer = setTimeout(done, ms);
            job.wake = done;
        });
    }
}
