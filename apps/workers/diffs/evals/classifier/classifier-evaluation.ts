import { createHash } from "node:crypto";
import path from "node:path";
import { InlineMp4VideoUploader, type ModelMessage, type UploadedVideo } from "@autonoma/ai";
import { type Codebase, type EvidenceLoader, StorageEvidenceLoader, readPrDiffStat } from "@autonoma/diffs";
import {
    CLASSIFIER_SYSTEM_PROMPT,
    ClassifierAgent,
    type ModelSession,
    type RunVerdict,
} from "@autonoma/diffs/analysis";
import { type CheckFailure, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { S3Storage } from "@autonoma/storage";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { expect } from "vitest";
import { z } from "zod";
import {
    type CaseSkipContext,
    type RunOutcome,
    ScoredReplayEvaluation,
    rehydrateOrSkip,
    skipIfEvidenceUnreachable,
} from "../framework";
import { type ClassifierFrontmatter, checkClassifierVerdict } from "./classifier-frontmatter";
import {
    type FrozenAppLogArtifact,
    type ClassifierCaseInput,
    type FrozenAppLogWindow,
    type FrozenClassifierInput,
    type FrozenRunMedia,
    rehydrateClassifierInput,
} from "./classifier-input";
import { type ClassifierResultRow, computeClassifierMetrics } from "./classifier-metrics";
import { formatClassifierMetrics } from "./classifier-metrics-report";
import { FrozenAppLogArtifactError, FrozenAppLogArtifactStore } from "./frozen-app-log-artifact";
import { createFrozenAppLogsLoader } from "./frozen-app-logs";
import { writeClassifierTranscript } from "./transcript-artifact";

/** A loaded Classifier eval case: frozen classification input + authored expectations. */
export type ClassifierCase = LoadedCase<ClassifierCaseInput, ClassifierFrontmatter>;

/** Per-case timeout: a classification is a tool loop over a real clone plus four full-recording vision reads. */
const TIMEOUT_MS = 900_000;

/** How far the classifier prompt's sha256 is truncated for the run tag - long enough to be unique, short to read. */
const PROMPT_SHA_LENGTH = 12;

/** The per-case fields the precision/recall aggregation reads back off `this.results` (everything else is stripped). */
const resultRowSchema = z.object({
    expectedCategory: z.string().optional(),
    category: z.string().optional(),
    modelId: z.string().optional(),
});

/**
 * What every run of a Classifier case shares, rehydrated once per case: the checked-out clone, the pure input,
 * the live diff stat, and the media/log evidence the run reads. The recording itself is NOT here - it is uploaded
 * fresh in {@link ClassifierEvaluation.runOnce}, since an uploaded handle can expire between suite runs.
 */
interface ClassifierContext {
    input: FrozenClassifierInput;
    codebase: Codebase;
    media: FrozenRunMedia;
    baseline: string;
    diffSummary: string;
    finalScreenshot?: Uint8Array;
    appLogWindow?: FrozenAppLogWindow;
    evidenceLoader: EvidenceLoader;
}

/**
 * Scored eval for the Investigator's classifier.
 *
 * Each case rehydrates the codebase from frozen coords, checks every storage key it references is still
 * downloadable, fetches the run's media and private app-log artifact, and runs {@link ClassifierAgent} directly -
 * no workflow or DB writes. The prior-runs baseline is served from frozen prose and `get_app_logs` from the frozen
 * log window; the recording and the PR's diff stat are read live, so a replay grades the vision probes alongside the
 * reasoning and touches nothing but git, S3 and the models.
 *
 * `get_preview_env` and `get_app_logs` ARE served, from the name list and the log window frozen at capture - the
 * two live-infra capabilities that reduce to data. `run_script` does not: it is a query against a live backend,
 * and the classifier is told as much through its own evidence-limits note, so it caps unprovable claims rather
 * than guessing; each case records in `productionCapabilities` whether production had more to work with than
 * this replay does.
 *
 * A case passes when its classification satisfies the deterministic checks AND the judge passes. Cases whose
 * codebase or media can no longer be fetched are skipped, not failed.
 *
 * Cases run concurrently: each rehydrates into its own git worktree off the shared repo clone.
 */
export class ClassifierEvaluation extends ScoredReplayEvaluation<
    ClassifierCaseInput,
    ClassifierFrontmatter,
    ClassifierContext,
    RunVerdict
> {
    private readonly transcriptDir: string;

    constructor(resultsDir: string, cases: ClassifierCase[]) {
        super({ name: "diffs-classifier", resultsDir, timeoutMs: TIMEOUT_MS }, cases);
        this.transcriptDir = path.join(resultsDir, "transcripts");
    }

    protected override testCaseInfo(testCase: ClassifierCase): Record<string, string> {
        const envNames = testCase.input.previewEnvNames;
        const appLogs = testCase.input.appLogs;
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            slug: testCase.input.test.slug,
            expectedCategory: testCase.frontmatter.category ?? "(unauthored)",
            capturedCategory: testCase.frontmatter.capturedCategory ?? "(unknown)",
            // Which tools production had that this replay does not, so a result file says outright when a case
            // is being graded against a classifier that could see less than the one it was captured from.
            productionOnlyTools: describeMissingTools(testCase.input),
            previewEnv: envNames != null ? `${envNames.length} names frozen` : "not frozen",
            appLogWindow: describeAppLogWindow(appLogs),
        };
    }

    /**
     * The base pass-rate metadata, plus per-plane and per-category precision/recall over the run's confusion
     * matrix, tagged with the prompt sha and the resolved model. Printed to stdout - the human copies the headline
     * into the trend by hand - and returned so it also lands in the (gitignored) result JSON's `metadata`. The
     * print lives here because `afterAll` is the one end-of-suite hook, and it reads this method for its own summary.
     */
    protected override evaluationMetadata(startTimestamp: number) {
        const base = super.evaluationMetadata(startTimestamp);
        const rows = this.parsedRows();
        const metrics = computeClassifierMetrics(rows);
        const promptSha = createHash("sha256")
            .update(CLASSIFIER_SYSTEM_PROMPT)
            .digest("hex")
            .slice(0, PROMPT_SHA_LENGTH);
        const model = rows.find((row) => row.modelId != null)?.modelId ?? "unknown";

        this.logger.info("Classifier eval precision/recall", {
            extra: { promptSha, model, scored: metrics.scored, planes: metrics.planes, clientBug: metrics.clientBug },
        });
        console.log(formatClassifierMetrics(metrics, { promptSha, model }));

        return { ...base, classifier: { promptSha, model, ...metrics } };
    }

    /**
     * Read each per-case row back off `this.results` as the pair the confusion matrix needs, plus the model id.
     * A row that fails to parse counts as unlabeled rather than throwing: this runs inside `evaluationMetadata`,
     * which the base calls BEFORE it writes the result file, so a single bad row must not sink the whole write.
     */
    private parsedRows(): Array<ClassifierResultRow & { modelId?: string }> {
        return this.results.map((result) => {
            const parsed = resultRowSchema.safeParse(result);
            if (!parsed.success) {
                this.logger.warn("Skipping unreadable result row in precision/recall", {
                    extra: { issues: parsed.error.issues },
                });
                return { expected: "" };
            }
            return {
                expected: parsed.data.expectedCategory ?? "",
                predicted: parsed.data.category,
                modelId: parsed.data.modelId,
            };
        });
    }

    protected override async setUp(testCase: ClassifierCase, helpers: RunCaseHelpers): Promise<ClassifierContext> {
        const { coords, input, media, baseline, appLogs } = rehydrateClassifierInput(testCase.input);
        const skipContext = { logger: this.logger, caseName: testCase.name };

        // The clone and the S3 probe are independent, so overlap the git-clone latency with the HEAD probes. The
        // diff stat below still waits on the clone, since it reads `codebase.root`.
        const evidenceLoader = new StorageEvidenceLoader(S3Storage.createFromEnv());
        const [codebase] = await Promise.all([
            rehydrateOrSkip(coords, helpers, skipContext),
            this.probeReferencedEvidence(media, evidenceLoader, helpers, skipContext),
        ]);

        // Read live rather than frozen, through the helper production calls: the stat is a pure function of the
        // two SHAs the case pins and the clone above, so freezing it could only go stale against that helper.
        const diffSummary = await readPrDiffStat({
            root: codebase.root,
            baseSha: coords.baseSha,
            headSha: coords.headSha,
        });

        const finalScreenshot = await this.loadFinalScreenshot(media, evidenceLoader);
        const appLogWindow = await this.loadAppLogWindow(appLogs, helpers, testCase.name);

        return { input, codebase, media, baseline, diffSummary, finalScreenshot, appLogWindow, evidenceLoader };
    }

    protected override async runOnce(
        session: ModelSession,
        testCase: ClassifierCase,
        context: ClassifierContext,
    ): Promise<RunOutcome<RunVerdict>> {
        const videoModel = session.getVideoModel({ model: "smart-video", tag: "classifier-eval-video" });
        const recording = await this.loadRecording(context.media, context.evidenceLoader);
        const classifierModel = session.getModel({ model: "classifier", tag: "classifier-eval" });
        const classifier = new ClassifierAgent({ model: classifierModel, videoModel: videoModel.model });

        const { verdict, conversation } = await this.classify(classifier, {
            ...context.input,
            run: { ...context.input.run, recording, finalScreenshot: context.finalScreenshot },
            codebase: context.codebase,
            diffSummary: context.diffSummary,
            screenshotLoader: context.evidenceLoader,
            loadBaseline: async () => context.baseline,
            // `previewEnv` rides in on `input` when the case froze one. `run_script` has no frozen form.
            previewScript: undefined,
            loadAppLogs: this.appLogsFor(context.appLogWindow, context.input.run),
        });
        const transcriptPath = await writeClassifierTranscript({
            dir: this.transcriptDir,
            caseName: testCase.name,
            conversation,
        });

        // `evidence` and `transcriptPath` carry the REASONING - the cited proof in the result file, the whole tool
        // loop on disk - so a verdict can be explained, not just counted.
        return {
            result: verdict,
            info: {
                category: verdict.category,
                // The resolved classifier model id, so the precision/recall block can tag a run by (promptSha, model)
                // and a comparison across runs knows whether the prompt or the model moved.
                modelId: classifierModel.modelId,
                confidence: verdict.confidence,
                planFidelity: verdict.planFidelity,
                headline: verdict.headline,
                evidence: verdict.evidence,
                evidenceCount: verdict.evidence.length,
                transcriptPath,
            },
        };
    }

    protected override check(verdict: RunVerdict, frontmatter: ClassifierFrontmatter): CheckFailure[] {
        return checkClassifierVerdict(verdict, frontmatter);
    }

    /**
     * `get_app_logs`, served from the frozen window over the run's own epochs - the same window production's
     * loader was pointed at, since capture read those epochs off the run it froze.
     *
     * Returning `undefined` omits the tool entirely, which is what a case with no frozen window needs: the
     * classifier is then told it cannot read logs, rather than being handed an empty window it would state to
     * itself as "the app emitted no matching error".
     */
    private appLogsFor(
        window: FrozenAppLogWindow | undefined,
        run: { startEpoch: number; endEpoch: number },
    ): ((regex: string) => Promise<string>) | undefined {
        if (window == null) return undefined;
        return createFrozenAppLogsLoader({
            window,
            startEpoch: run.startEpoch,
            endEpoch: run.endEpoch,
            logger: this.logger,
        });
    }

    private async loadAppLogWindow(
        artifact: FrozenAppLogArtifact | undefined,
        helpers: RunCaseHelpers,
        caseName: string,
    ): Promise<FrozenAppLogWindow | undefined> {
        if (artifact == null) return undefined;

        try {
            return await new FrozenAppLogArtifactStore(
                S3Storage.createFromEnv(FrozenAppLogArtifactStore.bucket),
                this.logger,
            ).read(artifact);
        } catch (err) {
            if (err instanceof FrozenAppLogArtifactError) {
                this.logger.warn("Skipping case: frozen app logs unavailable", {
                    extra: { case: caseName, key: err.key, reason: err.message },
                });
                helpers.skip(`frozen app logs unavailable: ${err.message}`);
            }
            throw err;
        }
    }

    /**
     * Run one classification. A classifier that exhausts its steps or loses a tool fatally throws instead of
     * returning a verdict - in production the workflow contains that as a coverage fault, but for an eval it is
     * simply a case that produced nothing to grade.
     */
    private async classify(
        classifier: ClassifierAgent,
        input: Parameters<ClassifierAgent["run"]>[0],
    ): Promise<{ verdict: RunVerdict; conversation: ModelMessage[] }> {
        try {
            const { result, conversation } = await classifier.run(input);
            return { verdict: result, conversation };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Classifier produced no verdict", { extra: { err: message } });
            expect.fail(`Classifier did not commit to a verdict: ${message}`);
        }
    }

    /**
     * Verify every storage key the case references is still downloadable, before spending a single model call.
     * Step frames are deliberately included: the model drills into two or three of them and a dead key would
     * surface mid-run as a tool error the classifier would then reason about as if it were evidence.
     */
    private async probeReferencedEvidence(
        media: FrozenRunMedia,
        evidenceLoader: EvidenceLoader,
        helpers: RunCaseHelpers,
        ctx: CaseSkipContext,
    ): Promise<void> {
        const screenshots: string[] = [];
        for (const step of media.inspectableSteps) {
            if (step.screenshotBeforeKey != null) screenshots.push(step.screenshotBeforeKey);
            if (step.screenshotAfterKey != null) screenshots.push(step.screenshotAfterKey);
        }

        await skipIfEvidenceUnreachable(
            { screenshots, finalScreenshot: media.finalScreenshotKey, video: media.recording?.key },
            evidenceLoader,
            helpers,
            ctx,
        );
    }

    private async loadFinalScreenshot(
        media: FrozenRunMedia,
        evidenceLoader: EvidenceLoader,
    ): Promise<Uint8Array | undefined> {
        if (media.finalScreenshotKey == null) return undefined;
        return new Uint8Array((await evidenceLoader.loadScreenshot(media.finalScreenshotKey)).buffer);
    }

    /**
     * Fetch the recording and hand it to the vision models in the form they take.
     *
     * Uploaded fresh each time the case is classified, never cached across suite runs: an uploaded video is a
     * handle with its own lifetime at the provider, so a stored handle could have expired by the next run.
     * The uploader is built with this host's ffmpeg for the same reason production builds its own - which
     * binary exists is not something the model registry can know.
     */
    private async loadRecording(
        media: FrozenRunMedia,
        evidenceLoader: EvidenceLoader,
    ): Promise<UploadedVideo | undefined> {
        const frozen = media.recording;
        if (frozen == null) return undefined;

        const bytes = await evidenceLoader.downloadVideo(frozen.key);
        const uploader = new InlineMp4VideoUploader(ffmpeg.path);
        return uploader.uploadVideo({
            data: { type: "buffer", buffer: Buffer.from(bytes).buffer },
            mimeType: frozen.isOptimizedMp4 ? "video/mp4" : "video/webm",
        });
    }
}

/**
 * The tools production had and this replay cannot serve, named for a result file.
 *
 * All of them existed only when previewkit deployed the PR - the one fact `previewkitManaged` records - so a case
 * from a PR without a preview has no gap to report. When it did, `run_script` is always gone (a query against a
 * live backend has no frozen form), while `get_preview_env` and `get_app_logs` are gone only when their frozen
 * data is absent: a case carrying the name list / the log window offers the same tool over the same data, so
 * listing it would report a gap that is not there.
 */
function describeMissingTools(input: ClassifierCaseInput): string {
    if (!input.productionCapabilities.previewkitManaged) return "none";

    const missing: string[] = [];
    if (input.previewEnvNames == null) missing.push("get_preview_env");
    missing.push("run_script");
    if (input.appLogs == null) missing.push("get_app_logs");
    return missing.join(", ");
}

/** How much log evidence the replay is serving, so a verdict resting on logs can be read against it. */
function describeAppLogWindow(appLogs: FrozenAppLogArtifact | undefined): string {
    if (appLogs == null) return "not frozen";
    const truncation = appLogs.windowTruncated ? " (window hit its cap; older lines were not frozen)" : "";
    return `${appLogs.lineCount} lines${truncation}`;
}
