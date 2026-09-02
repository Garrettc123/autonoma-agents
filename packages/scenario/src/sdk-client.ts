import { createHmac } from "node:crypto";
import { type Logger, logger } from "@autonoma/logger";
import type { DiscoverResponse, DownResponse, SdkFailure, UpResponse } from "@autonoma/types";
import { DiscoverResponseSchema, DownResponseSchema, UpResponseSchema } from "@autonoma/types";
import type { z } from "zod";
import { SdkCallError } from "./sdk-call-error";
import { NOOP_RECORDER, type SdkAction, type SdkCallRecorder } from "./sdk-call-recorder";
import { SdkHttpError } from "./sdk-http-error";

export interface SdkCallOptions {
    timeoutMs?: number;
}

/**
 * Cap on how much of a non-JSON response body we preserve. Customer endpoints
 * that error out often return a full HTML page (framework error page, proxy/CDN
 * 500, auth wall); we keep enough to identify the source without bloating the
 * `WebhookCall` row.
 */
const MAX_RAW_BODY_CHARS = 4_000;

const NON_JSON_EXCERPT_CHARS = 120;

const HTML_BLOCK_PATTERN = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const WHITESPACE_RUN_PATTERN = /\s+/g;

export interface SdkClientOptions {
    applicationId: string;
    sdkUrl: string;
    signingSecret: string;
    customHeaders?: Record<string, string>;
    recorder?: SdkCallRecorder;
}

/**
 * The protocol version discriminates the wire shape: v1 sends the resolved recipe
 * `create` graph; v2 sends only the scenario name (the customer's code owns the
 * data). Discriminated so a caller cannot pair a version with the wrong payload.
 */
export type SdkUpParams =
    | { protocolVersion: "1.0"; instanceId: string; create: Record<string, unknown> }
    | { protocolVersion: "2.0"; instanceId: string; scenarioName: string };

export type SdkDownParams =
    | { protocolVersion: "1.0"; instanceId: string; refs: Record<string, unknown> | null; refsToken?: string }
    | {
          // v2 carries teardown state solely in the opaque teardownToken, which the SDK verifies and routes by.
          protocolVersion: "2.0";
          instanceId: string;
          teardownToken?: string;
      };

interface CallParams<T> {
    instanceId?: string;
    action: SdkAction;
    body: unknown;
    responseSchema: z.ZodType<T>;
    timeoutMs: number;
}

type ParsedBody =
    | { kind: "json"; body: unknown }
    | { kind: "text"; rawText: string; contentType?: string; parseError: string };

/**
 * HMAC-signed HTTP client for the customer-deployed Autonoma SDK endpoint.
 *
 * Pure: no database, no global state. The optional `recorder` is the only
 * observability seam - inject `DbSdkCallRecorder` in production to persist
 * call rows, or pass nothing in tests.
 *
 * Each method performs a single request (no retries). A failed call surfaces
 * as a thrown error for the caller to handle.
 */
export class SdkClient {
    private readonly logger: Logger;
    private readonly applicationId: string;
    private readonly sdkUrl: string;
    private readonly signingSecret: string;
    private readonly customHeaders: Record<string, string>;
    private readonly recorder: SdkCallRecorder;

    constructor(options: SdkClientOptions) {
        this.applicationId = options.applicationId;
        this.sdkUrl = options.sdkUrl;
        this.signingSecret = options.signingSecret;
        this.customHeaders = options.customHeaders ?? {};
        this.recorder = options.recorder ?? NOOP_RECORDER;
        this.logger = logger.child({ name: this.constructor.name, applicationId: this.applicationId });
    }

    async discover(options?: SdkCallOptions): Promise<DiscoverResponse> {
        return this.call({
            action: "DISCOVER",
            body: { action: "discover" },
            responseSchema: DiscoverResponseSchema,
            timeoutMs: options?.timeoutMs ?? 90_000,
        });
    }

    async up(params: SdkUpParams, options?: SdkCallOptions): Promise<UpResponse> {
        const { instanceId } = params;
        const body =
            params.protocolVersion === "2.0"
                ? { action: "up", scenario: { name: params.scenarioName }, testRunId: instanceId }
                : { action: "up", create: params.create, testRunId: instanceId };
        return this.call({
            instanceId,
            action: "UP",
            body,
            responseSchema: UpResponseSchema,
            timeoutMs: options?.timeoutMs ?? 90_000,
        });
    }

    async down(params: SdkDownParams, options?: SdkCallOptions): Promise<DownResponse> {
        const { instanceId } = params;
        const body =
            params.protocolVersion === "2.0"
                ? { action: "down", teardownToken: params.teardownToken, testRunId: instanceId }
                : { action: "down", refs: params.refs, refsToken: params.refsToken, testRunId: instanceId };
        return this.call({
            instanceId,
            action: "DOWN",
            body,
            responseSchema: DownResponseSchema,
            timeoutMs: options?.timeoutMs ?? 60_000,
        });
    }

    private async call<T>(params: CallParams<T>): Promise<T> {
        const { instanceId, action, body, responseSchema, timeoutMs } = params;

        const startTime = Date.now();
        let response: { status: number; body: ParsedBody };
        try {
            response = await this.executeRequest(body, timeoutMs);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            const isTimeout = error.name === "TimeoutError" || error.name === "AbortError";
            // undici surfaces a connection failure as a generic "fetch failed" and puts the
            // real reason (ECONNREFUSED, ECONNRESET, ...) on error.cause. Fold that in so the
            // persisted error is legible instead of a bare "fetch failed" - and so cold-start
            // classification can actually see the connection reason.
            const cause = error.cause instanceof Error ? error.cause.message : undefined;
            const message = isTimeout
                ? `SDK call timed out after ${timeoutMs / 1000}s - ensure your endpoint is reachable and responds quickly`
                : cause != null && cause !== error.message
                  ? `${error.message}: ${cause}`
                  : error.message;
            const failure: SdkFailure = isTimeout ? { kind: "timed_out" } : { kind: "unreachable" };
            await this.recorder.record({
                applicationId: this.applicationId,
                instanceId,
                action,
                requestBody: body,
                durationMs: Date.now() - startTime,
                error: message,
            });
            this.logger.warn(`SDK ${action} failed`, { error: message });
            throw new SdkCallError(message, failure);
        }

        const { status, body: parsedBody } = response;
        const responseBody = recordedBody(parsedBody);
        await this.recorder.record({
            applicationId: this.applicationId,
            instanceId,
            action,
            requestBody: body,
            responseBody,
            statusCode: status,
            durationMs: Date.now() - startTime,
        });

        if (status < 200 || status >= 300) {
            const detail =
                parsedBody.kind === "json" ? extractResponseDetail(parsedBody.body) : describeNonJsonBody(parsedBody);
            const code = parsedBody.kind === "json" ? extractResponseCode(parsedBody.body) : undefined;
            const message = detail != null ? `SDK returned HTTP ${status}: ${detail}` : `SDK returned HTTP ${status}`;
            this.logger.warn(`SDK ${action} returned ${status}`, { status, responseBody });
            throw new SdkHttpError(status, message, code, detail);
        }

        const parsed = responseSchema.safeParse(responseBody);
        if (!parsed.success) {
            throw new SdkCallError(`SDK ${action} response validation failed: ${parsed.error.message}`, {
                kind: "bad_response",
            });
        }
        return parsed.data;
    }

    private async executeRequest(body: unknown, timeoutMs: number): Promise<{ status: number; body: ParsedBody }> {
        const bodyString = JSON.stringify(body);
        const signature = sign(bodyString, this.signingSecret);

        const response = await fetch(this.sdkUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": signature,
                ...this.customHeaders,
            },
            body: bodyString,
            signal: AbortSignal.timeout(timeoutMs),
        });

        const rawText = await response.text();
        return { status: response.status, body: parseResponseBody(rawText, response.headers) };
    }
}

function sign(body: string, signingSecret: string): string {
    return createHmac("sha256", signingSecret).update(body).digest("hex");
}

function parseResponseBody(rawText: string, headers: Headers): ParsedBody {
    try {
        return { kind: "json", body: JSON.parse(rawText) };
    } catch (error) {
        return {
            kind: "text",
            rawText,
            contentType: headers.get("content-type") ?? undefined,
            parseError: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * The body as persisted on `WebhookCall.responseBody`. A non-JSON body (e.g. an HTML error page) is the single most
 * useful artifact for debugging a failed customer endpoint, so instead of discarding it we record the raw text
 * (truncated), the declared content type, and why it did not parse.
 */
function recordedBody(parsed: ParsedBody): unknown {
    if (parsed.kind === "json") return parsed.body;
    return {
        error: `Error parsing response: ${parsed.parseError}`,
        contentType: parsed.contentType,
        rawBody: parsed.rawText.slice(0, MAX_RAW_BODY_CHARS),
    };
}

function describeNonJsonBody(parsed: { rawText: string; contentType?: string }): string {
    if (parsed.rawText.trim().length === 0) return "empty response body";

    const mediaType = parsed.contentType?.split(";")[0]?.trim();
    const label = mediaType != null && mediaType.length > 0 ? `non-JSON response (${mediaType})` : "non-JSON response";
    const text = parsed.rawText
        .replace(HTML_BLOCK_PATTERN, " ")
        .replace(HTML_TAG_PATTERN, " ")
        .replace(WHITESPACE_RUN_PATTERN, " ")
        .trim();
    if (text.length === 0) return `${label} with no readable text`;

    const excerpt = text.length > NON_JSON_EXCERPT_CHARS ? `${text.slice(0, NON_JSON_EXCERPT_CHARS)}...` : text;
    return `${label}: ${excerpt}`;
}

function extractResponseDetail(responseBody: unknown): string | undefined {
    if (responseBody == null || typeof responseBody !== "object") return undefined;
    const body = responseBody as Record<string, unknown>;
    const detail = body.message ?? body.error ?? body.detail;
    if (detail != null) {
        if (typeof detail === "string") {
            const trimmed = detail.trim();
            if (trimmed.length > 0) return trimmed;
        } else {
            return JSON.stringify(detail);
        }
    }

    const code = body.code;
    if (typeof code === "string" && code.trim().length > 0) {
        return `code=${code.trim()} - the SDK endpoint returned an empty error message; check the preview app runtime logs`;
    }
    return undefined;
}

/**
 * The SDK's contractual error `code` (e.g. `INTERNAL_ERROR`, `UNKNOWN_ENVIRONMENT`), when the non-2xx body carried
 * one. Its presence is what separates "the customer's handler answered with a structured error" (the scenario
 * plane) from "an ingress/proxy answered" (the environment plane) - so it rides onto `SdkHttpError` for the
 * analysis workflow to classify on. Absent for a gateway HTML page or any body without a `code`.
 */
function extractResponseCode(responseBody: unknown): string | undefined {
    if (responseBody == null || typeof responseBody !== "object" || !("code" in responseBody)) return undefined;
    const code = responseBody.code;
    if (typeof code !== "string") return undefined;
    const trimmed = code.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
