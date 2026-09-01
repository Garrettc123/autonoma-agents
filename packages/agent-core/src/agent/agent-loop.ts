import {
    stepCountIs,
    ToolLoopAgent,
    type ModelMessage,
    type PrepareStepFunction,
    type StepResult,
    type StopCondition,
    type Tool,
} from "ai";
import type { MessageCompactor } from "../compaction/types";
import { getDefaultLogger, type Logger } from "../logger";
import type { LanguageModel } from "../model";
import { redactForLog } from "./log-redaction";
import { logStepContent } from "./log-step";
import { withModelRetry } from "./retry-middleware";
import type { ReportResultTool } from "./tools/agent-result";
import type { AgentTool } from "./tools/agent-tool";
import { FatalToolError, FixableToolError } from "./tools/tool-errors";
import { stripMedia } from "./transcript";

type GenericToolSet = Record<string, Tool>;
type PrepareStepArgs = Parameters<PrepareStepFunction<GenericToolSet>>[0];
type PrepareStepReturn = Awaited<ReturnType<PrepareStepFunction<GenericToolSet>>>;
type AgentStepResult = StepResult<GenericToolSet>;

/**
 * Default step cap applied when {@link AgentConfig.maxSteps} is not provided. Deliberately large:
 * forcing `toolChoice: "required"` removes the loop's natural text-finish stop, so this acts purely
 * as a runaway backstop, not a tuning knob - well above any healthy run's real step count.
 */
export const DEFAULT_MAX_STEPS = 1000;

export interface AgentBudget {
    /** Ceiling on the whole loop. */
    totalMs: number;
    /** Ceiling on one step (model call + its retries). */
    stepMs: number;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
    totalMs: 15 * 60_000,
    stepMs: 6 * 60_000,
};

export interface AgentConfig<TResult> {
    /** A descriptive name for this type of agent, used for observability. */
    name: string;

    /** The model to use for the agent loop. */
    model: LanguageModel;

    /**
     * Maximum number of steps the agent will take before failing with {@link MaxStepsReached}.
     * Defaults to {@link DEFAULT_MAX_STEPS}. Because the loop forces a structured tool call on
     * every step (`toolChoice: "required"`), the model can never end its turn with plain text;
     * this cap is the loop's only other stop besides the report tool firing, so it is always set.
     */
    maxSteps?: number;

    /**
     * Wall-clock ceilings for a `runLoop` call. Set it from the deadline the caller itself runs under, so the
     * loop fails on its own terms rather than being killed from outside with nothing to report.
     */
    budget?: AgentBudget;

    /**
     * The system prompt of the agent.
     *
     * Must be set when constructing the agent, not at the start of the generation. This precludes
     * the system prompt from carrying dynamic per-run information, which is an intended design
     * restriction: anything that varies by run belongs in the user prompt.
     */
    systemPrompt: string;

    /** The tool used to report the result of the agent execution. */
    reportTool: ReportResultTool<unknown, TResult>;

    /** Tools that may be used during the execution of the agent loop. */
    tools: AgentTool<unknown, unknown>[];

    /**
     * Optional message-compaction configuration. When set, the loop calls `strategy.compact`
     * before each step whose previous step's reported input-token count meets or exceeds
     * `threshold`; the strategy's output replaces the messages sent to the model. The raw,
     * uncompacted message stream produced by the agent is what {@link AgentLoop.runLoop}
     * returns - compaction only affects what's sent to the model, never what's persisted.
     */
    compactor?: {
        strategy: MessageCompactor;
        /** Token budget for the previous step's input before the strategy runs. */
        threshold: number;
    };
}

/**
 * Base for every way a run ends without a result.
 *
 * Each carries the transcript as it stood when the run died, so the caller can persist it on the failure path.
 * Catch this rather than the individual subclasses when all you want is the conversation.
 */
export abstract class AgentLoopError extends FatalToolError {
    protected constructor(
        message: string,
        /**
         * The run's transcript, shaped by {@link AgentLoop.buildTranscript}. Empty only when the very first
         * model call failed before producing anything.
         */
        public readonly conversation: ModelMessage[],
        public readonly partialResult?: unknown,
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}

export class NoAgentResultError extends AgentLoopError {
    constructor(conversation: ModelMessage[], partialResult?: unknown) {
        super("No result was produced by the agent loop", conversation, partialResult);
    }
}

export class MaxStepsReached extends AgentLoopError {
    constructor(conversation: ModelMessage[], partialResult?: unknown) {
        super(
            "The agent loop reached the maximum number of steps without producing a result",
            conversation,
            partialResult,
        );
    }
}

/**
 * A tool call failed in a way the agent cannot fix by retrying - a {@link FatalToolError}, or any unclassified
 * error under the `stop_unless_fixable` policy - so the run ends rather than letting the model work around a
 * broken capability. Reaches the loop via {@link AgentLoop.recordFatalToolError}, not via the throw itself.
 */
export class ToolCallFailedFatally extends AgentLoopError {
    constructor(
        public readonly toolName: string,
        cause: Error,
        conversation: ModelMessage[],
        partialResult?: unknown,
    ) {
        super(`The \`${toolName}\` tool failed fatally: ${cause.message}`, conversation, partialResult, { cause });
    }
}

/**
 * The model call itself failed, so the loop never got to decide anything: the provider rejected every retry, the
 * prompt could not be converted (an unreachable media part), or a `prepareStep`/`onStepFinish` hook threw. Running
 * out of TIME instead is {@link AgentBudgetExceeded}. A tool throwing is {@link ToolCallFailedFatally}.
 */
export class AgentGenerationFailed extends AgentLoopError {
    constructor(cause: Error, conversation: ModelMessage[], partialResult?: unknown) {
        // The cause's message is inlined, not merely attached: failures are routinely categorized by string
        // (Temporal serializes an activity error to its message across the workflow boundary), so a wrapper
        // that kept the reason only on `.cause` would erase it at exactly the point it gets read.
        super(`The agent loop's model call failed: ${cause.message}`, conversation, partialResult, { cause });
    }
}

export class AgentBudgetExceeded extends AgentLoopError {
    constructor(
        agentName: string,
        public readonly elapsedMs: number,
        cause: Error,
        conversation: ModelMessage[],
        partialResult?: unknown,
    ) {
        super(
            `${agentName} ran out of time after ${formatElapsed(elapsedMs)} (${cause.message}). ` +
                "The model provider stopped answering within the budget, or the run needed more time than it has.",
            conversation,
            partialResult,
            { cause },
        );
    }
}

/**
 * A budget bound firing, as opposed to a caller's own cancellation: the SDK aborts a timed-out call with a
 * `TimeoutError`, while `AbortController.abort()` raises `AbortError`.
 */
function isBudgetTimeout(error: Error): boolean {
    return error.name === "TimeoutError";
}

function formatElapsed(elapsedMs: number): string {
    const seconds = Math.round(elapsedMs / 1000);
    if (seconds < 90) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export class MultipleResultCalls extends FixableToolError {
    constructor() {
        super("The result tool was called multiple times during the agent loop execution, which is not allowed");
    }

    public override suggestFix(): string {
        return "This run already has a result - the first call was accepted. Do not call the result tool again.";
    }
}

/** What {@link AgentLoop.runLoop} (and therefore {@link Agent.run}) returns. */
export interface AgentRunResult<TResult> {
    result: TResult;
    /**
     * The run's transcript: every message the model emitted - text, tool calls, tool results - as shaped by
     * {@link AgentLoop.buildTranscript}. {@link AgentLoopError.conversation} carries the same shape.
     */
    conversation: ModelMessage[];
}

/**
 * Per-run state holder for an agent.
 *
 * Keeps track of the {@link ToolLoopAgent} instance and the loop's accumulated result. Subclass to
 * carry additional per-run state - validation context, partial collectors, snapshot of state for
 * the report tool to read.
 */
export class AgentLoop<TResult = unknown> {
    protected readonly logger: Logger;

    protected result: TResult | undefined = undefined;

    /**
     * Every message the model has produced so far, refreshed after each step.
     *
     * Capturing per-step is what lets the transcript survive a model call that throws: `generate()` only hands
     * back its messages on the resolved path.
     */
    private modelMessages: ModelMessage[] = [];

    /** The first fatal tool failure of the run, recorded by {@link recordFatalToolError}. */
    private fatalToolError: { toolName: string; error: Error } | undefined = undefined;

    private readonly name: string;
    private readonly model: LanguageModel;
    private readonly systemPrompt: string;
    private readonly tools: AgentTool<unknown, unknown>[];
    private readonly resultTool: ReportResultTool<unknown, TResult>;
    private readonly maxSteps: number;
    private readonly budget: AgentBudget;
    private readonly compactor: { strategy: MessageCompactor; threshold: number } | undefined;

    constructor({
        name,
        model,
        systemPrompt,
        tools,
        reportTool: resultTool,
        maxSteps,
        budget,
        compactor,
    }: AgentConfig<TResult>) {
        this.name = name;
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.tools = tools;
        this.resultTool = resultTool;
        this.maxSteps = maxSteps ?? DEFAULT_MAX_STEPS;
        this.budget = budget ?? DEFAULT_AGENT_BUDGET;
        this.compactor = compactor;

        this.logger = getDefaultLogger().child({ name: this.name });
    }

    /** Set the result of the execution. Called by {@link ReportResultTool.execute}. */
    public setResult(result: TResult) {
        if (this.result !== undefined) {
            this.logger.warn("Result tool was called multiple times during agent loop execution; keeping the first", {
                keptResult: this.result,
                discardedResult: result,
            });
            throw new MultipleResultCalls();
        }

        this.logger.info("Setting result of agent loop", { result: redactForLog(result) });
        this.result = result;
    }

    /**
     * Record a tool failure the agent cannot recover from, ending the run at the end of the current step.
     *
     * Called by {@link AgentTool} at the point it decides a failure is fatal, because a thrown error cannot
     * carry that decision out on its own: the AI SDK turns any tool exception into a `tool-error` content part
     * and keeps going. Only the FIRST failure is kept - it is the one that ended the run, and later steps are
     * just the model reacting to it.
     */
    public recordFatalToolError(toolName: string, error: Error): void {
        if (this.fatalToolError != null) return;
        this.logger.fatal("Tool failed fatally; the agent loop will stop", { extra: { toolName } });
        this.fatalToolError = { toolName, error };
    }

    /**
     * Hook invoked before each step. Subclasses can override to inject per-step messages or
     * settings. Default implementation is identity (returns the input args unchanged).
     */
    protected async prepareStep(args: PrepareStepArgs): Promise<PrepareStepReturn> {
        return args;
    }

    /**
     * Hook invoked after each step finishes. The default logs the step's content via
     * {@link logStepContent} - subclasses can override or chain (`super.onStepFinish(result)`)
     * to add custom per-step side effects.
     */
    protected async onStepFinish(result: AgentStepResult): Promise<void> {
        logStepContent(this.logger, result.content);
    }

    /**
     * Optional hook subclasses can implement to expose a partial result when the loop terminates
     * without the report tool firing (e.g. max-steps reached, agent gave up). The returned value
     * is attached to {@link NoAgentResultError.partialResult} / {@link MaxStepsReached.partialResult}
     * so callers can persist partial state for debugging.
     */
    protected snapshotPartial?(): unknown;

    /**
     * Shape the transcript a caller receives on success and finds on {@link AgentLoopError.conversation} on
     * failure. The default is the model's own messages, unchanged.
     *
     * Override to ADD context an agent could not otherwise recover - a prompt built from non-deterministic
     * pre-loop work, say. Stripping binary content is not this hook's job: {@link stripMedia} runs on the
     * result either way.
     */
    protected buildTranscript(_userPrompt: ModelMessage[], modelMessages: ModelMessage[]): ModelMessage[] {
        return modelMessages;
    }

    /**
     * The transcript as a caller sees it, on every exit path. Media is stripped unconditionally rather than
     * left to {@link buildTranscript}, so a transcript can never carry inline image bytes into storage.
     */
    private transcriptFor(userPrompt: ModelMessage[], modelMessages: ModelMessage[]): ModelMessage[] {
        return stripMedia(this.buildTranscript(userPrompt, modelMessages));
    }

    /**
     * Custom stop condition that fires once the report tool has produced a result.
     */
    private readonly hasProducedResult: StopCondition<GenericToolSet> = () => this.result !== undefined;

    /** Stops the loop at the end of the step in which a tool failed fatally. */
    private readonly hasFatalToolError: StopCondition<GenericToolSet> = () => this.fatalToolError !== undefined;

    public async runLoop(userPrompt: ModelMessage[]): Promise<AgentRunResult<TResult>> {
        this.logger.info("Starting agent loop", { tools: this.tools.map((t) => t.name) });

        const tools: GenericToolSet = Object.fromEntries(
            [...this.tools, this.resultTool].map((t) => [t.name, t.toTool(this)]),
        );

        const agent = new ToolLoopAgent({
            model: withModelRetry(this.model),
            // Zero, or the two retry layers multiply: 10 of the SDK's times 10 of ours is 121 calls.
            maxRetries: 0,
            instructions: this.systemPrompt,
            tools,
            // Force a structured tool call on every step. Without this the AI SDK stops the loop as
            // soon as a step returns finishReason !== "tool-calls" (e.g. the model writes its result
            // as prose, ends with an empty turn, or types a tool call as text), which surfaced as
            // NoAgentResultError. "required" keeps finishReason at "tool-calls" until the report tool
            // sets the result and trips hasProducedResult.
            toolChoice: "required",
            stopWhen: [this.hasProducedResult, this.hasFatalToolError, stepCountIs(this.maxSteps)],
            prepareStep: async (args) =>
                applyCompactor(await this.prepareStep(args), args, this.compactor, this.logger),
            onStepFinish: (result) => {
                // `response.messages` is PER-STEP: it holds only what this step produced, so the running
                // transcript has to be accumulated here rather than overwritten by the latest snapshot.
                // Accumulating as we go is what lets a later throw still carry the conversation so far.
                this.modelMessages.push(...result.response.messages);
                return this.onStepFinish(result);
            },
        });

        const generationResult = await this.generateWithTranscript(userPrompt, () =>
            agent.generate({
                messages: userPrompt,
                timeout: this.budget,
            }),
        );
        const conversation = this.transcriptFor(userPrompt, generationResult.responseMessages);

        // Checked before the result: a fatal tool failure means the run was compromised, so even a result the
        // model managed to report in the same step is not one to trust.
        const fatal = this.fatalToolError;
        if (fatal != null) {
            throw new ToolCallFailedFatally(fatal.toolName, fatal.error, conversation, this.snapshotPartial?.());
        }

        if (this.result === undefined) {
            const partialResult = this.snapshotPartial?.();
            if (generationResult.steps.length >= this.maxSteps) {
                this.logger.fatal("Agent loop reached maximum number of steps without producing a result");
                throw new MaxStepsReached(conversation, partialResult);
            }
            this.logger.fatal("Agent loop finished without producing a result");
            throw new NoAgentResultError(conversation, partialResult);
        }

        this.logger.info("Agent loop finished successfully", { result: redactForLog(this.result) });

        return { result: this.result, conversation };
    }

    /**
     * Run the model loop, turning any rejection into an {@link AgentGenerationFailed} that still carries the
     * transcript captured up to that point.
     */
    private async generateWithTranscript<T>(userPrompt: ModelMessage[], generate: () => Promise<T>): Promise<T> {
        const startedAt = Date.now();
        try {
            return await generate();
        } catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            const elapsedMs = Date.now() - startedAt;
            const transcript = this.transcriptFor(userPrompt, this.modelMessages);

            if (isBudgetTimeout(cause)) {
                this.logger.fatal("Agent loop exceeded its budget", cause, {
                    extra: { elapsedMs, budget: this.budget, messagesSoFar: this.modelMessages.length },
                });
                throw new AgentBudgetExceeded(this.name, elapsedMs, cause, transcript, this.snapshotPartial?.());
            }

            this.logger.fatal("Agent loop's model call failed", cause, {
                extra: { elapsedMs, messagesSoFar: this.modelMessages.length },
            });
            throw new AgentGenerationFailed(cause, transcript, this.snapshotPartial?.());
        }
    }
}

async function applyCompactor(
    innerResult: PrepareStepReturn,
    args: PrepareStepArgs,
    compactor: { strategy: MessageCompactor; threshold: number } | undefined,
    logger: Logger,
): Promise<PrepareStepReturn> {
    if (compactor == null) return innerResult;

    const previousStepInputTokens = args.steps.at(-1)?.usage?.inputTokens ?? 0;
    const tripped = previousStepInputTokens >= compactor.threshold;
    logger.info("Compaction gate evaluated", {
        extra: { threshold: compactor.threshold, previousStepInputTokens, tripped },
    });
    if (!tripped) return innerResult;

    const messages = innerResult?.messages ?? args.messages;
    try {
        const compacted = await compactor.strategy.compact(messages);
        if (compacted.messagesAffected === 0) return innerResult;

        logger.info("Compaction strategy applied", {
            compaction: { strategy: compactor.strategy.name, messagesAffected: compacted.messagesAffected },
        });
        return { ...innerResult, messages: compacted.messages };
    } catch (error) {
        // Compaction is a safety net, not load-bearing for correctness: a strategy bug should not
        // take down a step that might otherwise succeed. Log and continue with uncompacted messages.
        logger.error(
            "Compaction strategy threw - continuing with uncompacted messages",
            error instanceof Error ? error : new Error(String(error)),
            { compaction: { strategy: compactor.strategy.name } },
        );
        return innerResult;
    }
}
