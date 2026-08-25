import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";

/**
 * The watcher's own configuration: a database and a logger. The Kubernetes client it uses to delete
 * runner Jobs validates its own variables on import (`@autonoma/k8s`), which is why `NAMESPACE` is
 * set in the manifest but absent here.
 */
export const env = createEnv({
    extends: [loggerEnv, dbEnv],
    server: {},
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
