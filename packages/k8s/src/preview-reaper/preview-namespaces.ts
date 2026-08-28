import { logger as rootLogger, type Logger } from "@autonoma/logger";
import { CoreV1Api, type KubeConfig } from "@kubernetes/client-node";
import {
    PREVIEWKIT_ENVIRONMENT_NAMESPACE_SELECTOR,
    PREVIEWKIT_PHASE_ANNOTATION,
    PREVIEWKIT_PR_NUMBER_LABEL,
    PREVIEWKIT_STATUS_ANNOTATION,
} from "../previewkit-labels";

/** A preview namespace as the reaper needs to see it. */
export interface PreviewNamespace {
    name: string;
    createdAt: Date;
    /** From the `previewkit.dev/pr-number` label; `0` is the main-branch environment. */
    prNumber: number;
    /**
     * The pipeline's last status/phase, mirrored onto the namespace by the deployer. The
     * namespace is therefore a recoverable copy of that state when the row disagrees, which
     * is what the reaper repair script reads. Absent on a namespace deployed before the
     * annotations existed.
     */
    status?: string;
    phase?: string;
}

/**
 * The cluster side of the reaper, kept to two operations so the sweep can be
 * tested against a real database and a stand-in cluster. A test that had to run
 * Kubernetes to prove "a row whose namespace is gone gets marked" would not be
 * worth writing, and that rule is the one carrying the risk.
 */
export interface PreviewNamespaces {
    /** Every preview ENVIRONMENT namespace that currently exists, whatever its name. */
    list(): Promise<PreviewNamespace[]>;
    delete(name: string): Promise<void>;
}

export class ClusterPreviewNamespaces implements PreviewNamespaces {
    private readonly logger: Logger;
    private readonly coreApi: CoreV1Api;

    constructor(kubeConfig: KubeConfig) {
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
    }

    async list(): Promise<PreviewNamespace[]> {
        const response = await this.coreApi.listNamespace({
            labelSelector: PREVIEWKIT_ENVIRONMENT_NAMESPACE_SELECTOR,
        });

        const namespaces = response.items.flatMap((item) => {
            const name = item.metadata?.name;
            const createdAt = item.metadata?.creationTimestamp;
            if (name == null || createdAt == null) return [];

            // The selector guarantees the label is present, so an unparseable value means
            // something other than the deployer wrote it. Skipping is the safe read: this
            // list drives deletion, and a namespace we cannot identify is one we must not
            // touch.
            const prNumber = Number(item.metadata?.labels?.[PREVIEWKIT_PR_NUMBER_LABEL]);
            if (!Number.isInteger(prNumber)) {
                this.logger.warn("Skipping preview namespace with an unreadable pr-number label", {
                    extra: { namespace: name, label: item.metadata?.labels?.[PREVIEWKIT_PR_NUMBER_LABEL] },
                });
                return [];
            }

            return [
                {
                    name,
                    createdAt: new Date(createdAt),
                    prNumber,
                    status: item.metadata?.annotations?.[PREVIEWKIT_STATUS_ANNOTATION],
                    phase: item.metadata?.annotations?.[PREVIEWKIT_PHASE_ANNOTATION],
                },
            ];
        });

        this.logger.info("Listed preview namespaces", { extra: { count: namespaces.length } });
        return namespaces;
    }

    async delete(name: string): Promise<void> {
        this.logger.info("Deleting preview namespace", { extra: { namespace: name } });
        await this.coreApi.deleteNamespace({ name });
    }
}
