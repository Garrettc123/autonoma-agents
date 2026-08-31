import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { debugLog } from "../../core/debug";
import { isMissingFile } from "../../core/is-missing-file";

/**
 * Marker the interactive agent writes as its last act, once every entity and the
 * full-recipe pass have validated. The agent owns all validation (per entity:
 * up -> DB check -> down -> DB check); this marker is how it reports the whole
 * session done, and its presence (with `complete: true`) is what the CLI submits on.
 */
export const COMPLETION_MARKER_FILE = ".sdk-integration-complete";

const completionSchema = z.object({ complete: z.literal(true) });

/**
 * Whether the agent reported the integration complete. Returns false (not a throw)
 * when the marker is missing or malformed, so a bailed/incomplete session degrades
 * to a bounded re-launch instead of crashing.
 */
export async function readCompletion(outputDir: string): Promise<boolean> {
    let raw: string;
    try {
        raw = await readFile(join(outputDir, COMPLETION_MARKER_FILE), "utf-8");
    } catch (err) {
        // The marker is absent for the whole session until the agent's last act, so its
        // absence is this function's normal answer, not an event. Anything else - a bad
        // outputDir, permissions, a full disk - means the marker can never arrive and the
        // watcher would wait forever, so that is the case worth a breadcrumb.
        if (!isMissingFile(err)) debugLog("Cannot read the completion marker", { err });
        return false;
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        debugLog("Completion marker is not valid JSON", { err });
        return false;
    }

    const parsed = completionSchema.safeParse(json);
    if (!parsed.success) {
        debugLog("Completion marker failed schema validation", { issues: parsed.error.issues });
        return false;
    }
    return true;
}
