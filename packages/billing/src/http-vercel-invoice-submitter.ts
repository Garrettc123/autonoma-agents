import type { PrismaClient } from "@autonoma/db";
import { ThirdPartyError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";
import type { VercelInvoiceSubmission, VercelInvoiceSubmitter } from "./types";

const logger = rootLogger.child({ name: "HttpVercelInvoiceSubmitter" });

const VERCEL_BILLING_API = "https://api.vercel.com/v1";

/** What Vercel answers when the submission's `externalId` is already taken on this installation. */
const HTTP_CONFLICT = 409;

const VercelInvoiceResponseSchema = z.object({ invoiceId: z.string() });

/**
 * Raises a one-off, off-cycle invoice on Vercel for a single credit package. Vercel's Submit
 * Invoice API requires an item to name a `billingPlanId`, so the purchase is attributed to the
 * installation's current plan while being priced entirely from the package the customer chose.
 *
 * Every submission carries an `externalId` derived from the purchase row. Vercel documents that an
 * `externalId`, when provided, must be unique for the installation, which turns this call into the
 * idempotency key the retry sweep needs: a purchase whose POST succeeded but whose invoice link
 * never committed is re-submitted with the same id and rejected, rather than billing the customer
 * twice for one package.
 *
 * `decryptToken` is injected rather than an `EncryptionHelper` being built here: the key lives in
 * each host's own validated env (`apps/api` for a sale, the invoicer cronjob for the retry sweep),
 * and this package must neither read `process.env` nor take on the crypto dependency to reach it.
 */
export class HttpVercelInvoiceSubmitter implements VercelInvoiceSubmitter {
    constructor(
        private readonly db: PrismaClient,
        private readonly decryptToken: (encrypted: string) => string,
    ) {}

    public async submitCreditPurchaseInvoice(input: {
        purchaseId: string;
        installationId: string;
        billingPeriodId: string;
        packageName: string;
        creditsGranted: number;
        priceCents: number;
    }): Promise<VercelInvoiceSubmission> {
        const installation = await this.db.vercelInstallation.findUniqueOrThrow({
            where: { id: input.installationId },
            select: { vercelInstallationId: true, accessTokenEnc: true, billingPlanId: true },
        });

        if (installation.accessTokenEnc == null || installation.billingPlanId == null) {
            throw new Error(`Installation ${input.installationId} cannot be invoiced`);
        }

        const accessToken = this.decryptToken(installation.accessTokenEnc);
        const amount = (input.priceCents / 100).toFixed(2);
        // A single instant, not a range: this bills a purchase that just happened, not a period of
        // consumption, and Vercel requires start/end regardless.
        const now = new Date().toISOString();

        const externalId = purchaseExternalId(input.purchaseId);
        const payload = {
            externalId,
            invoiceDate: now,
            memo: `${input.packageName} - ${input.creditsGranted.toLocaleString()} credits`,
            period: { start: now, end: now },
            items: [
                {
                    billingPlanId: installation.billingPlanId,
                    start: now,
                    end: now,
                    name: input.packageName,
                    details: `${input.creditsGranted.toLocaleString()} credits`,
                    price: amount,
                    quantity: 1,
                    units: "package",
                    total: amount,
                },
            ],
        };

        logger.info("Submitting credit purchase invoice to Vercel", {
            extra: { installationId: input.installationId, externalId, amount, creditsGranted: input.creditsGranted },
        });

        const url = `${VERCEL_BILLING_API}/installations/${installation.vercelInstallationId}/billing/invoices`;
        let res: Response;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
        } catch (error) {
            throw new ThirdPartyError("vercel", error, "Network error submitting credit purchase invoice");
        }

        const responseText = await res.text();

        // Vercel already holds an invoice under this `externalId`, so the customer has been billed
        // for this purchase - by an earlier attempt whose invoice link never committed. Reported as
        // an outcome rather than an error: re-POSTing is the only thing that must not happen, and
        // it is exactly what treating this as a retryable failure would cause.
        if (res.status === HTTP_CONFLICT) {
            logger.warn("Vercel already holds an invoice for this credit purchase, not resubmitting", {
                extra: { installationId: input.installationId, externalId, responseBody: responseText },
            });
            return { outcome: "already_submitted" };
        }

        if (!res.ok) {
            logger.error("Vercel credit purchase invoice submission failed", undefined, {
                extra: {
                    installationId: input.installationId,
                    externalId,
                    status: res.status,
                    responseBody: responseText,
                },
            });
            throw new ThirdPartyError(
                "vercel",
                new Error(`${res.status} ${responseText}`),
                `Vercel invoice submission failed: ${res.status}`,
            );
        }

        // A 2xx is not a promise of JSON - a proxy or an edge error page can answer with HTML - and a
        // raw SyntaxError here would surface as an unknown failure rather than as Vercel's. It has to
        // stay a throw either way: the invoice may well have been created, so the purchase must keep
        // `invoiceId: null` and be re-submitted under the same `externalId` rather than treated as sold
        // and unbilled.
        let body: unknown;
        try {
            body = JSON.parse(responseText);
        } catch (error) {
            logger.error("Vercel invoice API returned a non-JSON body", error, {
                extra: { installationId: input.installationId, externalId, status: res.status, responseText },
            });
            throw new ThirdPartyError("vercel", error, "Unparseable response from Vercel invoice API");
        }

        const parsed = VercelInvoiceResponseSchema.safeParse(body);
        if (!parsed.success) {
            throw new ThirdPartyError("vercel", parsed.error, "Invalid response from Vercel invoice API");
        }

        logger.info("Submitted credit purchase invoice to Vercel", {
            extra: { installationId: input.installationId, externalId, vercelInvoiceId: parsed.data.invoiceId },
        });
        return { outcome: "submitted", vercelInvoiceId: parsed.data.invoiceId };
    }
}

/**
 * The invoice's identity at Vercel, derived from the purchase row so every attempt at the same
 * purchase - the sale itself and every later sweep - computes the same value. Prefixed rather than
 * bare so a Vercel-side invoice list reads as ours.
 */
function purchaseExternalId(purchaseId: string): string {
    return `autonoma_purchase_${purchaseId}`;
}
