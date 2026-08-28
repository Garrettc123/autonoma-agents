import { z } from "zod";
import { Service } from "../service";
import type { QuerySender } from "./query-sender";

const BYTES_PER_GB = 1024 * 1024 * 1024;

// The previewkit agent's scrape interval (deployment/prometheus-agent/previewkit.yaml).
// Load-bearing for `queryGbSecondsByNamespace`: turning a count of gauge samples into
// seconds is only correct while this matches the agent. If the agent's interval changes,
// change this with it.
const SCRAPE_INTERVAL_SECONDS = 60;

const PrometheusQuerySuccessSchema = z.object({
    status: z.literal("success"),
    data: z.object({
        resultType: z.literal("vector"),
        result: z.array(
            z.object({
                metric: z.record(z.string(), z.string()),
                value: z.tuple([z.number(), z.string()]),
            }),
        ),
    }),
});

const PrometheusQueryErrorSchema = z.object({
    status: z.literal("error"),
    errorType: z.string().optional(),
    error: z.string().optional(),
});

const PrometheusQueryResponseSchema = z.union([PrometheusQuerySuccessSchema, PrometheusQueryErrorSchema]);

/**
 * Query helper for the two previewkit compute-billing series (vCPU-seconds and
 * memory GB-seconds) on the previewkit cluster. Both queries are grouped
 * `by (namespace)` so one call prices the whole fleet at once, regardless of how
 * many environments are due.
 *
 * Deliberately NOT scoped to a namespace pattern. cAdvisor series carry no namespace
 * labels, so the only way to filter here is by name - and this used to match
 * `namespace=~"preview-.+"`, which silently stopped matching anything when the
 * namespace format changed and took previewkit's running-compute billing with it for
 * weeks. The caller already holds the exact namespace of every environment it is
 * metering and looks each one up in the returned map, so selection belongs there,
 * where the names come from the database rather than from a guess about their shape.
 * The whole cluster is a few dozen namespaces; the extra series cost nothing.
 */
export class PrometheusClient extends Service {
    constructor(private readonly sender: QuerySender) {
        super();
    }

    /** vCPU-seconds consumed per namespace over the `windowMs` ending at `windowEnd`. */
    async queryVcpuSecondsByNamespace(windowEnd: Date, windowMs: number): Promise<Map<string, number>> {
        const range = toPromQlRange(windowMs);
        const query =
            `sum by (namespace) (increase(container_cpu_usage_seconds_total` +
            `{cluster="previewkit", container!=""}[${range}]))`;
        return this.queryByNamespace(query, windowEnd);
    }

    /**
     * Memory GB-seconds consumed per namespace over the `windowMs` ending at `windowEnd`.
     *
     * `sum_over_time` times the scrape interval, NOT `avg_over_time` times the window
     * length. `avg_over_time` averages only over the samples that exist, so a pod alive
     * for one minute of a fifteen-minute window reports its full working set as the
     * window's average and gets billed for all fifteen - a 15x overcharge on exactly the
     * short-lived pods previews are made of (scale-to-zero wakes, rollouts, hook Jobs).
     * Summing the samples and converting each to its scrape interval's worth of seconds
     * integrates the gauge instead of averaging it, so a pod is billed for the time it
     * actually existed.
     */
    async queryGbSecondsByNamespace(windowEnd: Date, windowMs: number): Promise<Map<string, number>> {
        const range = toPromQlRange(windowMs);
        const query =
            `sum by (namespace) (sum_over_time(container_memory_working_set_bytes` +
            `{cluster="previewkit", container!=""}[${range}]))` +
            ` * ${SCRAPE_INTERVAL_SECONDS} / ${BYTES_PER_GB}`;
        return this.queryByNamespace(query, windowEnd);
    }

    private async queryByNamespace(query: string, time: Date): Promise<Map<string, number>> {
        this.logger.info("Querying Prometheus", { query, time });

        const raw = await this.sender.send(query, time);
        const parsed = PrometheusQueryResponseSchema.safeParse(raw);

        if (!parsed.success) {
            throw new Error(`Prometheus query returned an unexpected response shape: ${parsed.error.message}`);
        }

        if (parsed.data.status === "error") {
            throw new Error(
                `Prometheus query error: ${parsed.data.errorType ?? "unknown"} - ${parsed.data.error ?? ""}`,
            );
        }

        const byNamespace = new Map<string, number>();
        for (const sample of parsed.data.data.result) {
            const namespace = sample.metric.namespace;
            if (namespace == null) continue;
            byNamespace.set(namespace, Number(sample.value[1]));
        }

        this.logger.info("Prometheus query complete", { query, namespaceCount: byNamespace.size });
        return byNamespace;
    }
}

/**
 * A PromQL range selector for a window length in milliseconds, always in seconds so it
 * cannot disagree with the caller's window. The range and the sweep's window MUST be the
 * same length: a shorter range under-bills, a longer one double-bills the overlap.
 */
function toPromQlRange(windowMs: number): string {
    return `${Math.round(windowMs / 1000)}s`;
}
