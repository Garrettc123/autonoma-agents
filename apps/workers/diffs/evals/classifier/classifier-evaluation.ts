import { InlineMp4VideoUploader, type UploadedVideo } from "@autonoma/ai";
import { type EvidenceLoader, StorageEvidenceLoader, readPrDiffStat, summarizeSessionCost } from "@autonoma/diffs";
import { ClassifierAgent, type RunVerdict } from "@autonoma/diffs/analysis";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { expect } from "vitest";
import { type CaseSkipContext, DiffsJudge, rehydrateOrSkip, skipIfEvidenceUnreachable } from "../framework";
import { type ClassifierFrontmatter, checkClassifierVerdict } from "./classifier-frontmatter";
import {
    type FrozenAppLogArtifact,
    type ClassifierCaseInput,
    type FrozenAppLogWindow,
    type FrozenRunMedia,
    rehydrateClassifierInput,
} from "./classifier-input";
import { FrozenAppLogArtifactError, FrozenAppLogArtifactStore } from "./frozen-app-log-artifact";
import { createFrozenAppLogsLoader } from "./frozen-app-logs";

/** A loaded Classifier eval case: frozen classification input + authored expectations. */
export type ClassifierCase = LoadedCase<ClassifierCaseInput, ClassifierFrontmatter>;

/** Per-case timeout: a classification is a tool loop over a real clone plus four full-recording vision reads. */
const TIMEOUT_MS = 900_000;

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
export class ClassifierEvaluation extends Evaluation<ClassifierCase> {
    private readonly judge = new DiffsJudge();
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    constructor(resultsDir: string, cases: ClassifierCase[]) {
        super(
            {
                name: "diffs-classifier",
                parallel: true,
                testOptions: { timeout: TIMEOUT_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: ClassifierCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
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

    protected override async runCase(
        testCase: ClassifierCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

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

        // Imported here rather than at module scope: `services` pulls the worker's env, which demands the
        // GitHub App and OpenAI credentials at import time and would break the credential-free zero-case no-op.
        const { createModelSession } = await import("../../src/services");

        const session = createModelSession();
        const videoModel = session.getVideoModel({ model: "smart-video", tag: "classifier-eval-video" });
        const recording = await this.loadRecording(media, evidenceLoader);
        const classifier = new ClassifierAgent({
            model: session.getModel({ model: "classifier", tag: "classifier-eval" }),
            videoModel: videoModel.model,
        });

        this.logger.info("Classifying eval case", { extra: { case: testCase.name } });

        const verdict = await this.classify(classifier, {
            ...input,
            run: { ...input.run, recording, finalScreenshot },
            codebase,
            diffSummary,
            screenshotLoader: evidenceLoader,
            loadBaseline: async () => baseline,
            // `previewEnv` rides in on `input` when the case froze one. `run_script` has no frozen form.
            previewScript: undefined,
            loadAppLogs: this.appLogsFor(appLogWindow, input.run),
        });

        // The full verdict, not just a pass flag: diffing two result files is how a change is shown to have moved
        // the classifier. Stability is measured by running the whole suite more than once and diffing, not by
        // re-classifying one case in a serial loop.
        addInfo({
            category: verdict.category,
            confidence: verdict.confidence,
            planFidelity: verdict.planFidelity,
            headline: verdict.headline,
            evidenceCount: verdict.evidence.length,
            agentCost: summarizeSessionCost(session.costCollector),
        });

        // Deterministic checks gate the (paid) judge call: a case that already fails enum-equality cannot pass.
        const failures = checkClassifierVerdict(verdict, testCase.frontmatter);
        if (failures.length > 0) {
            const detail = failures.map((f) => `${f.check}: ${f.message}`).join("; ");
            addInfo({ deterministicFailures: detail });
            expect.fail(`Deterministic checks failed: ${detail}`);
        }

        // One judge call. The rubric grades reasoning quality, which the deterministic checks have gated.
        const judgeVerdict = await this.judge.judge({ output: verdict, rubric: testCase.rubric });
        addInfo({
            judgePassed: judgeVerdict.passed,
            judgeReasoning: judgeVerdict.reasoning,
            judgeCost: judgeVerdict.cost,
        });

        expect(judgeVerdict.passed, `Judge failed: ${judgeVerdict.reasoning}`).toBe(true);
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
    ): Promise<RunVerdict> {
        try {
            const { result } = await classifier.run(input);
            return result;
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
