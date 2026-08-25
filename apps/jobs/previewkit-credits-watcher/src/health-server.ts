import { createServer, type Server } from "node:http";
import type { Logger } from "@autonoma/logger";

const HEALTH_PATH = "/healthz";

export interface HealthServerOptions {
    port: number;
    /**
     * Whether the sweep loop is still coming back around. A long-running watcher has one failure
     * mode a CronJob's fresh pod per tick did not: the process stays up while a sweep hangs on a
     * wedged query or a Kubernetes call that never returns, and credit enforcement silently stops
     * with nothing crashed to notice. Returning false here is what gets the pod restarted.
     */
    isLive: () => boolean;
    logger: Logger;
}

/** Serves the liveness endpoint the Deployment's probe polls. */
export function startHealthServer({ port, isLive, logger }: HealthServerOptions): Server {
    const server = createServer((request, response) => {
        if (request.url !== HEALTH_PATH) {
            response.writeHead(404).end();
            return;
        }

        const live = isLive();
        if (!live) logger.warn("Liveness probe failing: no sweep has completed recently");
        response.writeHead(live ? 200 : 503, { "content-type": "text/plain" }).end(live ? "ok" : "stale");
    });

    server.on("error", (error) => logger.captureError(error));
    server.listen(port, () => logger.info("Health server listening", { extra: { port, path: HEALTH_PATH } }));

    return server;
}
