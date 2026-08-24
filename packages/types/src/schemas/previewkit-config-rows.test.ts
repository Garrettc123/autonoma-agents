import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type PreviewConfig, trustedPreviewConfigSchema } from "./previewkit-config";
import {
    documentFromPreviewkitConfigRows,
    type PreviewkitConfigRowValues,
    type PreviewkitConfigRows,
    previewkitConfigRowValues,
} from "./previewkit-config-rows";

/**
 * Mirrors what Postgres does to decomposed values on the way in: an absent
 * optional becomes a null column. Standing in for the DB keeps these tests pure -
 * the real thing is exercised by the api and previewkit integration suites.
 */
function store(values: PreviewkitConfigRowValues): PreviewkitConfigRows {
    return {
        domain: values.domain ?? null,
        registry: values.registry ?? null,
        branchConventionType: values.branchConventionType ?? null,
        branchConventionPattern: values.branchConventionPattern ?? null,
        branchConventionReplacement: values.branchConventionReplacement ?? null,
        repositories: values.repositories.map((repository) => ({
            position: repository.position,
            repo: repository.repo,
            fallbackBranch: repository.fallbackBranch,
            sha: repository.sha ?? null,
        })),
        apps: values.apps.map((app) => ({
            position: app.position,
            name: app.name,
            repository: app.repository,
            path: app.path,
            buildContext: app.buildContext ?? null,
            dockerfile: app.dockerfile ?? null,
            build: app.build ?? null,
            blueprint: app.blueprint ?? null,
            port: app.port ?? null,
            command: app.command ?? null,
            primary: app.primary ?? null,
            sdkImplemented: app.sdkImplemented ?? null,
            sdkPath: app.sdkPath ?? null,
            resourcesTier: app.resourcesTier,
            dependsOn: app.dependsOn,
            connections: app.connections,
        })),
        services: values.services.map((service) => ({
            position: service.position,
            name: service.name,
            recipe: service.recipe,
            version: service.version ?? null,
            options: service.options,
            resourcesTier: service.resourcesTier,
            setupTasks: service.setupTasks,
        })),
        hooks: values.hooks,
    };
}

/**
 * `depends_on` is the one field a row cannot represent exactly: it is optional
 * with no default, and an array column cannot tell absent from empty. Both sides
 * of a comparison read it the way every consumer does.
 */
function normalize(config: PreviewConfig): PreviewConfig {
    return {
        ...config,
        apps: config.apps.map((app) => ({ ...app, depends_on: app.depends_on ?? [] })),
    };
}

function parse(document: unknown): PreviewConfig {
    return trustedPreviewConfigSchema.parse(document);
}

/** Parse -> decompose -> store -> compose -> parse, the full storage round trip. */
function roundTrip(document: unknown): PreviewConfig {
    return parse(documentFromPreviewkitConfigRows(store(previewkitConfigRowValues(parse(document)))));
}

function expectRoundTrip(document: unknown): PreviewConfig {
    const result = roundTrip(document);
    expect(normalize(result)).toEqual(normalize(parse(document)));
    return result;
}

const MINIMAL = {
    version: 2,
    apps: [{ name: "web", repository: "acme/web", port: 3000 }],
};

/**
 * Every field the config schema carries, and which of them the codec is
 * responsible for. A fixture round trip cannot catch a field nobody thought to
 * put in a fixture - `sdk_path` was stored, dropped on the way to rows, and only
 * found by a parity sweep over real data - so these lists are asserted against
 * the schema itself. Adding a field to the schema fails this test until the codec
 * carries it and the field is listed here.
 */
const SCHEMA_FIELDS = {
    top: ["version", "domain", "registry", "repositories", "branch_convention", "apps", "services", "hooks"],
    app: [
        "id",
        "name",
        "repository",
        "path",
        "build_context",
        "dockerfile",
        "build",
        "blueprint",
        "port",
        "connections",
        "command",
        "primary",
        "sdk_implemented",
        "sdk_path",
        "resources",
        "depends_on",
    ],
    service: ["name", "recipe", "version", "options", "setup_tasks", "resources"],
};

const objectNode = z.object({ properties: z.record(z.string(), z.unknown()) });
const arrayNode = z.object({ items: z.unknown() });

/** The output-side property names at one level of the schema, via Zod's own reflection. */
function schemaFields(level: "top" | "app" | "service"): string[] {
    const json = z.toJSONSchema(trustedPreviewConfigSchema, { io: "output", unrepresentable: "any" });
    const top = objectNode.parse(json).properties;
    if (level === "top") return Object.keys(top);

    const collection = level === "app" ? top.apps : top.services;
    return Object.keys(objectNode.parse(arrayNode.parse(collection).items).properties);
}

describe("preview config field coverage", () => {
    it.each(["top", "app", "service"] as const)("carries every %s-level field the schema defines", (level) => {
        expect(schemaFields(level).sort()).toEqual([...SCHEMA_FIELDS[level]].sort());
    });
});

describe("preview config rows round trip", () => {
    it("preserves a minimal document", () => {
        const config = expectRoundTrip(MINIMAL);

        expect(config.apps[0]?.path).toBe(".");
        expect(config.services).toEqual([]);
        expect(config.hooks).toEqual({ pre_deploy: [], post_deploy: [] });
    });

    it("preserves a full multirepo topology", () => {
        const config = expectRoundTrip({
            version: 2,
            domain: "preview.example.com",
            registry: "ghcr.io/acme",
            repositories: [{ repo: "acme/web" }, { repo: "acme/api", fallback_branch: "develop", sha: "a".repeat(40) }],
            branch_convention: { type: "regex", pattern: "^feat/(.*)$", replacement: "feature/$1" },
            apps: [
                {
                    name: "web",
                    repository: "acme/web",
                    path: "apps/web",
                    port: 3000,
                    primary: true,
                    sdk_implemented: true,
                    command: "node server.js",
                    build_context: "root",
                    depends_on: ["api"],
                    connections: [
                        { key: "API_URL", value: "{{api.url}}" },
                        { key: "DATABASE_URL", value: "{{db.url}}", build_time: true },
                    ],
                    build: { framework: "dockerfile", dockerfile: "Dockerfile", target: "runner" },
                },
                {
                    name: "api",
                    repository: "acme/api",
                    port: 4000,
                    blueprint: { preset: "fastapi", run_command: "uvicorn app:app" },
                },
            ],
            services: [
                {
                    name: "db",
                    recipe: "postgres",
                    version: "16",
                    options: { database: "preview", user: "preview" },
                    setup_tasks: [
                        {
                            command: "psql -f db/schema.sql",
                            frequency: "on_create",
                            location: { type: "separate_job", repo: "acme/api" },
                        },
                        {
                            command: "pnpm migrate",
                            frequency: "every_commit",
                            location: { type: "in_build", app: "api", position: "after" },
                        },
                    ],
                },
            ],
            hooks: {
                pre_deploy: [{ app: "api", command: "pnpm migrate" }],
                post_deploy: [
                    { app: "api", command: "pnpm seed" },
                    { app: "web", command: "pnpm warm" },
                ],
            },
        });

        expect(config.apps.map((app) => app.name)).toEqual(["web", "api"]);
        expect(config.repositories[1]?.sha).toBe("a".repeat(40));
        expect(config.branch_convention).toEqual({
            type: "regex",
            pattern: "^feat/(.*)$",
            replacement: "feature/$1",
        });
        expect(config.hooks.post_deploy.map((step) => step.command)).toEqual(["pnpm seed", "pnpm warm"]);
    });

    /**
     * Raw quantities no longer survive as themselves - a size is a tier now, and the
     * row stores which one. A request nothing covers takes the largest tier, because
     * the alternative is refusing to read a config that is already deployed.
     */
    it("snaps a resource override onto a tier and stays there", () => {
        const document = {
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000, resources: { cpu: "2", memory: "4Gi" } }],
            services: [{ name: "db", recipe: "postgres", resources: { cpu: "1", memory: "2Gi" } }],
        };

        const config = expectRoundTrip(document);

        expect(config.apps[0]?.resources).toEqual({ tier: "xlarge", cpu: "500m", memory: "2Gi" });
        expect(config.services[0]?.resources).toEqual({ tier: "large", cpu: "500m", memory: "2Gi" });

        // The composed document names the tier, so reading it back does not snap
        // again. Without this the size would creep on every save.
        const again = roundTrip(documentFromPreviewkitConfigRows(store(previewkitConfigRowValues(config))));
        expect(again.apps[0]?.resources).toEqual(config.apps[0]?.resources);
        expect(again.services[0]?.resources).toEqual(config.services[0]?.resources);
    });

    it("preserves a retired framework preset, which stored documents may still carry", () => {
        const config = expectRoundTrip({
            version: 2,
            apps: [
                {
                    name: "web",
                    repository: "acme/web",
                    port: 3000,
                    build: { framework: "next", node_version: "20", build_command: "pnpm build" },
                },
            ],
        });

        expect(config.apps[0]?.build).toMatchObject({ framework: "next", node_version: "20" });
    });

    it("preserves a dockerfile blueprint and a bare dockerfile alike", () => {
        const config = expectRoundTrip({
            version: 2,
            apps: [
                {
                    name: "web",
                    repository: "acme/web",
                    port: 3000,
                    blueprint: { dockerfile: "docker/web.Dockerfile", build_context: "root" },
                },
                { name: "api", repository: "acme/web", port: 4000, dockerfile: "docker/api.Dockerfile" },
            ],
        });

        expect(config.apps[0]?.blueprint).toEqual({ dockerfile: "docker/web.Dockerfile", build_context: "root" });
        expect(config.apps[1]?.dockerfile).toBe("docker/api.Dockerfile");
    });

    it("preserves an explicit false, which a missing field would not mean", () => {
        const config = expectRoundTrip({
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000, primary: false, sdk_implemented: false }],
        });

        expect(config.apps[0]?.primary).toBe(false);
        expect(config.apps[0]?.sdk_implemented).toBe(false);
    });

    it("preserves a declared sdk_path, which absent does not stand in for", () => {
        const config = expectRoundTrip({
            version: 2,
            apps: [
                { name: "web", repository: "acme/web", port: 3000, sdk_implemented: true, sdk_path: "/autonoma" },
                { name: "api", repository: "acme/web", port: 4000 },
            ],
        });

        expect(config.apps[0]?.sdk_path).toBe("/autonoma");
        expect(config.apps[1]?.sdk_path).toBeUndefined();
    });

    it("composes an empty depends_on away, so absent and empty both read as empty", () => {
        const stored = store(previewkitConfigRowValues(parse(MINIMAL)));

        expect(documentFromPreviewkitConfigRows(stored)).toMatchObject({
            apps: [expect.objectContaining({ depends_on: undefined })],
        });
        expect(roundTrip(MINIMAL).apps[0]?.depends_on).toBeUndefined();
    });
});

describe("documentFromPreviewkitConfigRows", () => {
    const rows = store(
        previewkitConfigRowValues(
            parse({
                version: 2,
                apps: [
                    {
                        name: "web",
                        repository: "acme/web",
                        port: 3000,
                        connections: [
                            { key: "A", value: "1" },
                            { key: "B", value: "2" },
                        ],
                    },
                    { name: "api", repository: "acme/web", port: 4000 },
                ],
                hooks: {
                    pre_deploy: [
                        { app: "api", command: "first" },
                        { app: "api", command: "second" },
                    ],
                    post_deploy: [{ app: "web", command: "last" }],
                },
            }),
        ),
    );

    it("orders by position rather than trusting the order rows arrive in", () => {
        const shuffled: PreviewkitConfigRows = {
            ...rows,
            apps: [...rows.apps].reverse().map((app) => ({ ...app, connections: [...app.connections].reverse() })),
            hooks: [...rows.hooks].reverse(),
        };

        expect(documentFromPreviewkitConfigRows(shuffled)).toEqual(documentFromPreviewkitConfigRows(rows));
        expect(parse(documentFromPreviewkitConfigRows(shuffled)).hooks.pre_deploy.map((step) => step.command)).toEqual([
            "first",
            "second",
        ]);
    });

    it("stamps the document version, which is never stored", () => {
        expect(documentFromPreviewkitConfigRows(rows)).toMatchObject({ version: 2 });
    });

    it("passes a half-written regex convention through so the reader rejects it", () => {
        const broken: PreviewkitConfigRows = { ...rows, branchConventionType: "regex" };

        expect(trustedPreviewConfigSchema.safeParse(documentFromPreviewkitConfigRows(broken)).success).toBe(false);
    });
});

describe("legacy aws flag mirror columns", () => {
    function decomposeService(service: Record<string, unknown>) {
        const config = trustedPreviewConfigSchema.parse({
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000 }],
            services: [{ name: "aws", recipe: "aws", ...service }],
        });
        return previewkitConfigRowValues(config).services[0]!;
    }

    /**
     * Service rows are delete-then-create on save, so these write-only mirrors are
     * what keeps the columns the PREVIOUS release reads populated across a save. If
     * this stops emitting them, the first save under the new release nulls the
     * columns and a rollback deploys the aws service with nothing enabled.
     */
    it("mirrors the options flags into the transition columns", () => {
        const values = decomposeService({ options: { s3: true, sqs: false } });

        expect(values.s3).toBe(true);
        expect(values.sqs).toBe(false);
        expect(values.sns).toBeUndefined();
    });

    it("mirrors a legacy top-level document the same way, through the fold", () => {
        const values = decomposeService({ s3: true, sns: true });

        expect(values.s3).toBe(true);
        expect(values.sns).toBe(true);
        expect(values.options).toEqual({ s3: true, sns: true });
    });

    it("mirrors nothing for a service that never had the flags", () => {
        const values = decomposeService({ options: { database: "d" } });

        expect(values.s3).toBeUndefined();
        expect(values.sqs).toBeUndefined();
        expect(values.sns).toBeUndefined();
    });
});

describe("portless apps", () => {
    /**
     * An absent port must survive as ABSENT, not as a null that a reader's schema
     * then rejects, and not as a zero. It is the whole declaration that the app
     * accepts no inbound connections, so losing it in storage silently restores
     * the readiness probe that a worker can never pass.
     */
    it("round trips an app that declares no port", () => {
        const result = expectRoundTrip({
            version: 2,
            apps: [
                { name: "web", repository: "acme/web", port: 3000 },
                { name: "temporal-worker", repository: "acme/web" },
            ],
        });

        // Undefined, never null: a null reaches the reader's schema as a type error
        // on a field it would otherwise accept as absent.
        expect(result.apps[1]?.port).toBeUndefined();
        expect(result.apps[1]?.port).not.toBeNull();
        expect(result.apps[0]?.port).toBe(3000);
    });

    it("decomposes an absent port to an absent column value", () => {
        const values = previewkitConfigRowValues(
            parse({ version: 2, apps: [{ name: "temporal-worker", repository: "acme/web" }] }),
        );
        expect(values.apps[0]?.port).toBeUndefined();
    });
});
