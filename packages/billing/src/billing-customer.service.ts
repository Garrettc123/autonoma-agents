import type { PrismaClient } from "@autonoma/db";
import { CreditTransactionType } from "@autonoma/db";
import { BadRequestError, NotFoundError, SpendCapExceededError } from "@autonoma/errors";
import { BILLING_PAYMENT_INTENT_TYPES, BILLING_TOPUP_SOURCES } from "@autonoma/types";
import { ensureBillingProvisioning } from "./billing-provisioning";
import type { BillingTopupPackageService } from "./billing-topup-package.service";
import { buildCustomerCreateIdempotencyKey, isUniqueConstraintError } from "./billing-utils";
import { env } from "./env";
import { Service } from "./service";
import type { SpendCapService } from "./spend-cap.service";
import { getStripe } from "./stripe-client";
import { syncStripeDataToDb } from "./stripe-sync";
import type { SubscriptionStatusResult } from "./types";

export class BillingCustomerService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly packageService: BillingTopupPackageService,
        private readonly spendCapService: SpendCapService,
    ) {
        super();
    }

    private buildAbsoluteAppUrl(pathWithQuery: string): string {
        return new URL(pathWithQuery, env.APP_URL).toString();
    }

    private buildCheckoutSuccessUrl(pathWithQuery: string): string {
        const url = new URL(pathWithQuery, env.APP_URL);
        url.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
        return url.toString();
    }

    private resolveCheckoutReturnPaths(returnPath?: string): { cancelPath: string; successPath: string } {
        const fallbackPath = "/billing";
        if (returnPath == null || returnPath.trim().length === 0) {
            return { cancelPath: fallbackPath, successPath: fallbackPath };
        }

        const normalizedPath = returnPath.trim();
        if (!normalizedPath.startsWith("/") || normalizedPath.startsWith("//")) {
            return { cancelPath: fallbackPath, successPath: fallbackPath };
        }

        const appBranchMatch = normalizedPath.match(/^\/app\/([^/]+)\//);
        if (appBranchMatch != null) {
            return {
                cancelPath: normalizedPath,
                successPath: `/app/${appBranchMatch[1]}/billing`,
            };
        }

        if (normalizedPath.startsWith("/billing")) {
            return { cancelPath: normalizedPath, successPath: fallbackPath };
        }

        return { cancelPath: normalizedPath, successPath: fallbackPath };
    }

    async getOrCreateCustomer(organizationId: string, orgName: string) {
        const existing = await ensureBillingProvisioning(this.db, organizationId);
        if (existing.stripeCustomerId != null) return existing;

        const stripe = getStripe();
        const stripeCustomer = await stripe.customers.create(
            {
                name: orgName,
                metadata: { organizationId },
            },
            {
                idempotencyKey: buildCustomerCreateIdempotencyKey(organizationId),
            },
        );

        try {
            const customer = await this.db.billingCustomer.update({
                where: { organizationId },
                data: { stripeCustomerId: stripeCustomer.id },
            });

            this.logger.info("Created Stripe customer", { organizationId, stripeCustomerId: stripeCustomer.id });
            return customer;
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                const customer = await this.db.billingCustomer.findUnique({
                    where: { organizationId },
                });
                if (customer != null) return customer;
            }

            throw error;
        }
    }

    async createCheckoutSession(organizationId: string, returnPath?: string, packageId?: string) {
        const org = await this.db.organization.findUnique({
            where: { id: organizationId },
            select: { name: true },
        });
        if (org == null) throw new NotFoundError("Organization not found");

        const customer = await this.getOrCreateCustomer(organizationId, org.name ?? organizationId);
        if (customer.stripeCustomerId == null) {
            throw new Error(`Stripe customer missing for organization ${organizationId}`);
        }
        const stripe = getStripe();
        const { cancelPath, successPath } = this.resolveCheckoutReturnPaths(returnPath);
        const cancelUrl = this.buildAbsoluteAppUrl(cancelPath);
        const successUrl = this.buildCheckoutSuccessUrl(successPath);

        if (packageId == null) throw new BadRequestError("A top-up package must be selected");

        const topupPackage = await this.packageService.findById(packageId);
        if (topupPackage == null || !topupPackage.isActive) {
            throw new BadRequestError("Selected top-up package is not available");
        }

        const eligibility = await this.spendCapService.checkCheckoutEligibility(
            organizationId,
            topupPackage.priceCents,
        );
        if (!eligibility.allowed) {
            throw new SpendCapExceededError(
                "This purchase would exceed your organization's spend cap for this period.",
            );
        }

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer: customer.stripeCustomerId,
            line_items: [{ price: topupPackage.stripePriceId, quantity: 1 }],
            payment_intent_data: {
                setup_future_usage: "off_session",
                metadata: {
                    type: BILLING_PAYMENT_INTENT_TYPES.TOPUP,
                    organizationId,
                    packageId: topupPackage.id,
                    source: BILLING_TOPUP_SOURCES.MANUAL,
                },
            },
            success_url: successUrl,
            cancel_url: cancelUrl,
        });

        this.logger.info("Created topup checkout session", {
            organizationId,
            sessionId: session.id,
            packageId: topupPackage.id,
        });
        return { url: session.url };
    }

    async createPortalSession(organizationId: string, returnPath?: string) {
        const org = await this.db.organization.findUnique({
            where: { id: organizationId },
            select: { name: true },
        });
        if (org == null) throw new NotFoundError("Organization not found");

        const customer = await this.getOrCreateCustomer(organizationId, org.name ?? organizationId);
        if (customer.stripeCustomerId == null) {
            throw new Error(`Stripe customer missing for organization ${organizationId}`);
        }

        const { cancelPath } = this.resolveCheckoutReturnPaths(returnPath);
        const returnUrl = this.buildAbsoluteAppUrl(cancelPath);
        const stripe = getStripe();
        const session = await stripe.billingPortal.sessions.create({
            customer: customer.stripeCustomerId,
            return_url: returnUrl,
        });

        this.logger.info("Created billing portal session", { organizationId });
        return { url: session.url };
    }

    /**
     * The organization's subscription status on its own, for the app shell's upgrade button.
     *
     * Separate from {@link getBillingStatus} because the shell renders on every page and needs one
     * enum, not a balance, a lifetime aggregate and the last 20 transactions. Answers with an
     * object rather than a bare value so a missing billing row is still valid React Query data.
     */
    async getSubscriptionStatus(organizationId: string): Promise<SubscriptionStatusResult> {
        this.logger.info("Reading subscription status", { organization: { organizationId } });

        const customer = await this.db.billingCustomer.findUnique({
            where: { organizationId },
            select: { subscriptionStatus: true },
        });

        return { subscriptionStatus: customer?.subscriptionStatus ?? undefined };
    }

    async getBillingStatus(organizationId: string) {
        // The aggregate is keyed only on `organizationId`, so it never waits on the customer read.
        // The cost of running them together is one cheap aggregate for an organization with no
        // billing row, which the early return below used to skip.
        const [customer, llmProxyAggregate] = await Promise.all([
            this.db.billingCustomer.findUnique({
                where: { organizationId },
                select: {
                    creditBalance: true,
                    subscriptionCreditBalance: true,
                    provider: true,
                    subscriptionStatus: true,
                    currentPeriodEnd: true,
                    cancelAtPeriodEnd: true,
                    gracePeriodEndsAt: true,
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: true,
                    autoTopUpPackageId: true,
                    transactions: {
                        orderBy: { createdAt: "desc" },
                        take: 20,
                    },
                },
            }),
            // All-time spend through the managed LLM proxy (planner CLI). The transactions list is
            // capped at 20, so we aggregate separately to surface the lifetime total in the UI.
            this.db.creditTransaction.aggregate({
                where: { organizationId, type: CreditTransactionType.LLM_PROXY_CONSUMPTION },
                _sum: { amount: true },
            }),
        ]);

        if (customer == null) {
            return {
                creditBalance: 0,
                subscriptionCreditBalance: 0,
                topupCreditBalance: 0,
                provider: "stripe",
                subscriptionStatus: undefined,
                currentPeriodEnd: undefined,
                cancelAtPeriodEnd: false,
                gracePeriodEndsAt: undefined,
                autoTopUpEnabled: false,
                autoTopUpThreshold: 0,
                autoTopUpPackageId: undefined,
                cliCreditsSpent: 0,
                transactions: [],
            };
        }

        const cliCreditsSpent = Math.abs(llmProxyAggregate._sum.amount ?? 0);

        return {
            creditBalance: customer.creditBalance,
            subscriptionCreditBalance: customer.subscriptionCreditBalance,
            topupCreditBalance: Math.max(0, customer.creditBalance - customer.subscriptionCreditBalance),
            provider: customer.provider,
            subscriptionStatus: customer.subscriptionStatus ?? undefined,
            currentPeriodEnd: customer.currentPeriodEnd ?? undefined,
            cancelAtPeriodEnd: customer.cancelAtPeriodEnd,
            gracePeriodEndsAt: customer.gracePeriodEndsAt ?? undefined,
            autoTopUpEnabled: customer.autoTopUpEnabled,
            autoTopUpThreshold: customer.autoTopUpThreshold,
            autoTopUpPackageId: customer.autoTopUpPackageId ?? undefined,
            cliCreditsSpent,
            transactions: customer.transactions,
        };
    }

    async startGracePeriodByStripeCustomerId(stripeCustomerId: string, gracePeriodDays: number) {
        const graceEndsAt = new Date(Date.now() + gracePeriodDays * 24 * 60 * 60 * 1000);
        const result = await this.db.billingCustomer.updateMany({
            where: { stripeCustomerId },
            data: { gracePeriodEndsAt: graceEndsAt },
        });
        this.logger.info("Updated billing grace period", {
            stripeCustomerId,
            gracePeriodDays,
            graceEndsAt,
            updatedCustomers: result.count,
        });
    }

    async startGracePeriodByOrganizationId(organizationId: string, gracePeriodDays: number) {
        const graceEndsAt = new Date(Date.now() + gracePeriodDays * 24 * 60 * 60 * 1000);
        await this.db.billingCustomer.updateMany({
            where: { organizationId },
            data: { gracePeriodEndsAt: graceEndsAt },
        });
        this.logger.info("Updated billing grace period by organization", {
            organizationId,
            gracePeriodDays,
            graceEndsAt,
        });
    }

    async clearGracePeriodByStripeCustomerId(stripeCustomerId: string) {
        const result = await this.db.billingCustomer.updateMany({
            where: { stripeCustomerId },
            data: { gracePeriodEndsAt: null },
        });
        this.logger.info("Cleared billing grace period", { stripeCustomerId, updatedCustomers: result.count });
    }

    async updateAutoTopUp(organizationId: string, enabled: boolean, threshold: number, packageId?: string) {
        const org = await this.db.organization.findUnique({
            where: { id: organizationId },
            select: { name: true },
        });
        if (org == null) throw new NotFoundError("Organization not found");

        if (enabled && packageId == null) {
            throw new BadRequestError("A top-up package must be selected to enable auto top-up");
        }

        if (packageId != null) {
            const topupPackage = await this.packageService.findById(packageId);
            if (topupPackage == null || !topupPackage.isActive) {
                throw new BadRequestError("Selected top-up package is not available");
            }
        }

        await this.getOrCreateCustomer(organizationId, org.name ?? organizationId);

        await this.db.billingCustomer.update({
            where: { organizationId },
            data: { autoTopUpEnabled: enabled, autoTopUpThreshold: threshold, autoTopUpPackageId: packageId },
        });

        this.logger.info("Updated auto top-up settings", { organizationId, enabled, threshold, packageId });
    }

    async syncFromStripe(stripeCustomerId: string) {
        await syncStripeDataToDb(stripeCustomerId, this.db);
    }

    async findCustomerByStripeId(stripeCustomerId: string) {
        return this.db.billingCustomer.findUnique({
            where: { stripeCustomerId },
        });
    }
}
