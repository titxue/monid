import { type Bundle, type EndpointDoc, sealUnit } from "@shared/core";
import {
    type ConnectorEngine,
    credentialEnvVarFor,
    credentialFieldsOf,
    envCredentialsPresent,
    type RunnableEndpoint,
} from "@monid/connector-engine";

export class GatewayError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

export interface SearchOptions {
    query?: string;
    provider?: string;
    category?: string;
    configuredOnly?: boolean;
    limit?: number;
}

const aliases: Record<string, string> = {
    "推特": "twitter tweet",
    "抓取": "scrape scraping",
    "采集": "scrape",
    "搜索": "search",
    "网页": "web",
    "公司": "company",
    "邮箱": "email",
    "评论": "review",
    "视频": "video",
    "图片": "image",
    "语音": "voice audio",
    "领英": "linkedin",
};
const stopWords = new Set([
    "a",
    "an",
    "the",
    "of",
    "for",
    "to",
    "and",
    "find",
    "get",
]);

export class Catalog {
    constructor(
        readonly bundle: Bundle,
        private readonly engine: ConnectorEngine,
        private readonly configured = (doc: EndpointDoc) =>
            envCredentialsPresent(
                doc.provider,
                credentialFieldsOf(doc.auth.credentials),
            ),
        private readonly allowedProviders?: Set<string>,
    ) {}

    private visible(doc: EndpointDoc): boolean {
        return !this.allowedProviders ||
            this.allowedProviders.has(doc.provider);
    }

    availability(doc: EndpointDoc) {
        const configured = this.configured(doc);
        const supported = !doc.resources;
        return {
            configured,
            supported,
            runnable: configured && supported,
            ...(supported ? {} : {
                unavailableReason:
                    "Resource lifecycle is not supported by this gateway yet.",
            }),
        };
    }

    get(id: string): EndpointDoc {
        const doc = this.bundle.endpoints[id];
        if (!doc || !this.visible(doc)) {
            throw new GatewayError(
                404,
                "ENDPOINT_NOT_FOUND",
                `Unknown endpoint: ${id}`,
            );
        }
        return doc;
    }

    providers() {
        return Object.values(this.bundle.providers)
            .filter((provider) =>
                !this.allowedProviders ||
                this.allowedProviders.has(provider.name)
            )
            .map((provider) => {
                const docs = Object.values(this.bundle.endpoints).filter((
                    doc,
                ) => doc.provider === provider.name);
                return {
                    provider: provider.name,
                    ...provider.meta,
                    endpointCount: docs.length,
                    configured: docs.some((doc) => this.configured(doc)),
                };
            });
    }

    discover(options: SearchOptions = {}) {
        const query = (options.query ?? "").toLowerCase().trim();
        const expanded = query + " " + Object.entries(aliases)
            .filter(([word]) => query.includes(word)).map(([, words]) => words)
            .join(" ");
        const tokens = [...new Set(expanded.match(/[\p{L}\p{N}]+/gu) ?? [])]
            .filter((word) => !stopWords.has(word));
        const results = Object.values(this.bundle.endpoints)
            .filter((doc) => this.visible(doc))
            .filter((doc) =>
                !options.provider || doc.provider === options.provider
            )
            .filter((doc) =>
                !options.category ||
                doc.meta.categories?.includes(options.category)
            )
            .filter((doc) =>
                !options.configuredOnly || this.availability(doc).runnable
            )
            .map((doc) => {
                const name =
                    `${doc.id} ${doc.meta.displayName} ${doc.meta.summary}`
                        .toLowerCase();
                const text = `${name} ${doc.meta.description ?? ""} ${
                    (doc.meta.categories ?? []).join(" ")
                }`.toLowerCase();
                const score = tokens.length === 0
                    ? 1
                    : tokens.reduce((sum, token) =>
                        sum + (name.includes(token)
                            ? 1
                            : text.includes(token)
                            ? 0.5
                            : 0), 0) / tokens.length;
                return {
                    id: doc.id,
                    provider: doc.provider,
                    endpoint: doc.endpoint,
                    name: doc.meta.displayName,
                    description: doc.meta.summary,
                    categories: doc.meta.categories ?? [],
                    score,
                    usageModel: doc.usage.model,
                    ...this.availability(doc),
                };
            })
            .filter((result) => result.score > 0)
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        return {
            query: options.query ?? "",
            total: results.length,
            results: results.slice(0, options.limit ?? 10),
            searchMode: "keyword",
        };
    }

    inspect(id: string) {
        const doc = this.get(id);
        return {
            id: doc.id,
            provider: doc.provider,
            endpoint: doc.endpoint,
            ...doc.meta,
            method: doc.request.method,
            input: doc.input.schema,
            output: doc.output.schema,
            usageModel: doc.usage.model,
            creditSystems: doc.usage.credits,
            credentialEnvVars: credentialFieldsOf(doc.auth.credentials)
                .map((field) => credentialEnvVarFor(doc.provider, field)),
            asynchronous: !!doc.lifecycle?.poll,
            stoppable: !!doc.lifecycle?.stop,
            timeouts: doc.timeouts,
            ...this.availability(doc),
        };
    }

    async load(id: string): Promise<RunnableEndpoint> {
        return await this.engine.load(sealUnit(this.bundle, this.get(id).id));
    }

    assertRunnable(id: string): void {
        const availability = this.availability(this.get(id));
        if (!availability.supported) {
            throw new GatewayError(
                422,
                "UNSUPPORTED_RESOURCE",
                availability.unavailableReason!,
            );
        }
        if (!availability.configured) {
            throw new GatewayError(
                422,
                "MISSING_CREDENTIAL",
                "Configure this provider's credentials on the gateway server first.",
            );
        }
    }
}
