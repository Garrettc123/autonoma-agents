import { describe, expect, test } from "vitest";
import { PrometheusClient } from "../src/preview-usage-meter/prometheus-client";
import { FakeQuerySender } from "./fake-query-sender";

/** The sweep's window, passed through so the range selector and the window cannot disagree. */
const WINDOW_MS = 15 * 60 * 1000;

describe("PrometheusClient", () => {
    test("queries vCPU-seconds by namespace and parses the vector response", async () => {
        const sender = new FakeQuerySender();
        const windowEnd = new Date("2026-07-21T12:15:00.000Z");
        sender.respondAt(windowEnd, {
            cpu: [
                { namespace: "acme-web-1-c6156866caa8da6f", value: 12.5 },
                { namespace: "acme-web-2-b1cbb134b89f0bdc", value: 0 },
            ],
        });

        const client = new PrometheusClient(sender);
        const result = await client.queryVcpuSecondsByNamespace(windowEnd, WINDOW_MS);

        expect(result.get("acme-web-1-c6156866caa8da6f")).toBe(12.5);
        expect(result.get("acme-web-2-b1cbb134b89f0bdc")).toBe(0);
        expect(result.has("acme-web-3-043190108bde2ec9")).toBe(false);

        expect(sender.calls).toHaveLength(1);
        expect(sender.calls[0]?.query).toContain("container_cpu_usage_seconds_total");
        expect(sender.calls[0]?.query).toContain("increase(");
    });

    /**
     * The regression this pins: the queries used to filter `namespace=~"preview-.+"`, which
     * matched nothing once namespaces became `{owner}-{repo}-{N}-{hash}` and silently stopped
     * billing every preview's running compute. Selection is the sweep's job, from names it
     * reads out of the database - there must be no name-shaped filter here at all.
     */
    test("scopes to the cluster and never filters namespaces by name", async () => {
        const sender = new FakeQuerySender();
        const windowEnd = new Date("2026-07-21T12:15:00.000Z");
        const client = new PrometheusClient(sender);

        await client.queryVcpuSecondsByNamespace(windowEnd, WINDOW_MS);
        await client.queryGbSecondsByNamespace(windowEnd, WINDOW_MS);

        for (const call of sender.calls) {
            expect(call.query).toContain('cluster="previewkit"');
            expect(call.query).not.toContain("namespace=~");
            expect(call.query).not.toContain("preview-");
        }
    });

    test("derives the range selector from the window it is given", async () => {
        const sender = new FakeQuerySender();
        const windowEnd = new Date("2026-07-21T12:15:00.000Z");
        const client = new PrometheusClient(sender);

        await client.queryVcpuSecondsByNamespace(windowEnd, WINDOW_MS);
        await client.queryVcpuSecondsByNamespace(windowEnd, 5 * 60 * 1000);

        expect(sender.calls[0]?.query).toContain("[900s]");
        expect(sender.calls[1]?.query).toContain("[300s]");
    });

    /**
     * GB-seconds must INTEGRATE the gauge, not average it. `avg_over_time` averages only over
     * samples that exist, so a pod alive one minute of a fifteen-minute window reported its
     * full working set as the window average and was billed for all fifteen.
     */
    test("queries memory as summed samples times the scrape interval, not an average", async () => {
        const sender = new FakeQuerySender();
        const windowEnd = new Date("2026-07-21T12:30:00.000Z");
        sender.respondAt(windowEnd, { memory: [{ namespace: "acme-web-1-c6156866caa8da6f", value: 119.5 }] });

        const client = new PrometheusClient(sender);
        const result = await client.queryGbSecondsByNamespace(windowEnd, WINDOW_MS);

        expect(result.get("acme-web-1-c6156866caa8da6f")).toBe(119.5);
        expect(sender.calls[0]?.query).toContain("container_memory_working_set_bytes");
        expect(sender.calls[0]?.query).toContain("sum_over_time(");
        expect(sender.calls[0]?.query).not.toContain("avg_over_time(");
        expect(sender.calls[0]?.query).toContain("* 60");
        expect(sender.calls[0]?.query).toContain("/ 1073741824");
    });

    test("returns an empty map when the window has no samples", async () => {
        const sender = new FakeQuerySender();
        const windowEnd = new Date("2026-07-21T12:45:00.000Z");
        // No respondAt call configured for this window - defaults to an empty result vector.

        const client = new PrometheusClient(sender);
        const result = await client.queryVcpuSecondsByNamespace(windowEnd, WINDOW_MS);

        expect(result.size).toBe(0);
    });

    test("throws on a Prometheus error response", async () => {
        const sender = new FakeQuerySender();
        const windowEnd = new Date("2026-07-21T13:00:00.000Z");
        sender.respondAt(windowEnd, { cpu: "error" });

        const client = new PrometheusClient(sender);
        await expect(client.queryVcpuSecondsByNamespace(windowEnd, WINDOW_MS)).rejects.toThrow(
            /Prometheus query error/,
        );
    });

    test("throws on a response that doesn't match the expected shape", async () => {
        const sender = { send: async () => ({ unexpected: true }) };
        const client = new PrometheusClient(sender);

        await expect(client.queryVcpuSecondsByNamespace(new Date(), WINDOW_MS)).rejects.toThrow(
            /unexpected response shape/,
        );
    });
});
