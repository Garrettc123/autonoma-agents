import {
    ApplicationArchitecture,
    CreditTransactionType,
    type PrismaClient,
    PreviewkitStatus,
    SubscriptionStatus,
    createClient,
} from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness } from "@autonoma/integration-test";
import { AutoTopUpService } from "../src/auto-topup.service";
import { EnabledBillingService } from "../src/billing-enabled.service";
import { BillingPricingService } from "../src/billing-pricing.service";
import { BillingTopupPackageService } from "../src/billing-topup-package.service";
import { CreditsService } from "../src/credits.service";
import { LoggingBillingAlertNotifier } from "../src/logging-billing-alert-notifier";
import { SpendCapService } from "../src/spend-cap.service";
import type { BillingService } from "../src/types";
import { VercelInvoiceStatus, type VercelInvoiceStatusValue } from "../src/vercel-invoice-status";
import { VercelOverageService } from "../src/vercel-overage.service";

const REPO_FULL_NAME = "test-org/repo";
/** One repository behind every environment here, so an org has exactly one application. */
const REPOSITORY_ID = 4242;

export interface CreatePreviewkitEnvironmentInput {
    organizationId: string;
    status?: PreviewkitStatus;
    meteredAt?: Date;
    deployedAt?: Date;
    tornDownAt?: Date;
}

export interface CreatedPreviewkitEnvironment {
    id: string;
    organizationId: string;
    namespace: string;
}

/**
 * Real-Postgres harness for the billing credit logic. Mirrors the scenario
 * harness: a throwaway Postgres testcontainer with migrations applied. We never
 * mock the DB - the deduction logic is raw SQL (row locks, idempotency, balance
 * clamping), so only a real database exercises it meaningfully.
 */
export class BillingTestHarness implements IntegrationHarness {
    public readonly db: PrismaClient;
    public readonly creditsService: CreditsService;
    public readonly billingService: BillingService;
    /** Direct access to reservation/refund internals not exposed on the `BillingService` facade. */
    public readonly spendCapService: SpendCapService;
    public readonly topupPackageService: BillingTopupPackageService;
    public readonly pricingService: BillingPricingService;

    private previewkitEnvironmentSeq = 0;
    private vercelInvoiceSeq = 0;
    private previewkitAppSeq = 0;

    constructor(db: PrismaClient) {
        this.db = db;
        const alertNotifier = new LoggingBillingAlertNotifier();
        this.spendCapService = new SpendCapService(db, alertNotifier);
        this.topupPackageService = new BillingTopupPackageService(db);
        this.pricingService = new BillingPricingService(db);
        this.creditsService = new CreditsService(
            db,
            new AutoTopUpService(db, this.topupPackageService, this.spendCapService),
            this.pricingService,
            new VercelOverageService(db),
            this.topupPackageService,
            this.spendCapService,
        );
        this.billingService = new EnabledBillingService(db);
    }

    static async create(): Promise<BillingTestHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        return new BillingTestHarness(db);
    }

    async beforeAll() {
        // No-op - harness is ready after create()
    }

    async afterAll() {
        await this.db.$disconnect();
    }

    async beforeEach() {
        // Cascades from organization to billing_customer, billing_pricing,
        // credit_transaction, and previewkit_environment/previewkit_usage_window -
        // every test starts from an empty table, so the previewkit usage-meter
        // sweep (which scans across all environments, not a single org) never
        // sees another test's leftover rows.
        await this.db.$executeRawUnsafe('TRUNCATE TABLE "organization" CASCADE');
    }

    async afterEach() {
        // No-op
    }

    /**
     * Create an org with a billing customer at a known credit balance. Pricing is
     * left to default (creditsPerTopup=150000 for stripeTopupAmountCents=10000 =
     * 1500 credits/USD), created lazily on first deduction.
     */
    async createOrgWithBalance(creditBalance: number): Promise<string> {
        const date = Date.now();
        const org = await this.db.organization.create({
            data: { name: `Billing Org ${date}`, slug: `billing-org-${date}-${Math.floor(creditBalance)}` },
        });
        await this.db.billingCustomer.create({
            data: { organizationId: org.id, creditBalance },
        });
        return org.id;
    }

    /**
     * Records a settled top-up purchase, which is what `hasEverPaid` reads to allow an overdraft.
     * A real ledger row rather than a flag, because that row is the actual signal - the same one
     * `grantTopupCredits` writes once Stripe reports the payment intent succeeded.
     */
    async recordSettledTopupPurchase(organizationId: string, amount = 150_000): Promise<void> {
        const customer = await this.db.billingCustomer.findUniqueOrThrow({ where: { organizationId } });
        await this.db.creditTransaction.create({
            data: {
                organizationId,
                type: CreditTransactionType.TOPUP_PURCHASE,
                amount,
                balanceAfter: customer.creditBalance,
                stripePaymentIntentId: `pi_paid_${organizationId}_${Date.now()}`,
            },
        });
    }

    /** The compensating negative row a refund writes, which nets off a settled purchase. */
    async recordTopupRefund(organizationId: string, amount = 150_000): Promise<void> {
        const customer = await this.db.billingCustomer.findUniqueOrThrow({ where: { organizationId } });
        await this.db.creditTransaction.create({
            data: {
                organizationId,
                type: CreditTransactionType.TOPUP_REFUND,
                amount: -amount,
                balanceAfter: customer.creditBalance,
                stripeRefundId: `re_${organizationId}_${Date.now()}`,
            },
        });
    }

    /**
     * A Vercel invoice for this org, settled unless told otherwise. The `paidAt` distinction is the
     * whole point on that rail: a credit purchase raises an invoice immediately but the money only
     * arrives when Vercel reports it paid.
     *
     * A refunded invoice keeps its `paidAt`, exactly as `processVercelInvoiceRefunded` leaves it -
     * that is the shape `hasEverPaid` has to tell apart from a still-settled one.
     */
    async recordVercelInvoice(
        organizationId: string,
        { status = VercelInvoiceStatus.Paid }: { status?: VercelInvoiceStatusValue } = {},
    ): Promise<void> {
        const seq = this.vercelInvoiceSeq++;
        const user = await this.db.user.create({
            data: { name: `Vercel User ${seq}`, email: `vercel-${seq}-${Date.now()}@example.com` },
        });
        const plan = await this.db.vercelBillingPlan.create({
            data: { name: `Vercel Plan ${seq}-${Date.now()}`, description: "Test plan", cost: "50.00", details: {} },
        });
        const installation = await this.db.vercelInstallation.create({
            data: {
                vercelInstallationId: `icfg_${seq}_${Date.now()}`,
                vercelAccountId: `team_${seq}`,
                vercelUserId: `vuser_${seq}`,
                organizationId,
                userId: user.id,
                billingPlanId: plan.id,
            },
        });
        const period = await this.db.vercelBillingPeriod.create({
            data: {
                installationId: installation.id,
                planId: plan.id,
                endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
        });

        await this.db.vercelInvoice.create({
            data: {
                installationId: installation.id,
                billingPeriodId: period.id,
                vercelInvoiceId: `inv_${seq}_${Date.now()}`,
                amount: "100.00",
                status,
                paidAt: status === VercelInvoiceStatus.Pending ? undefined : new Date(),
            },
        });
    }

    /**
     * The legacy Stripe subscriber's shape: it pays by invoice, so it has no `TOPUP_PURCHASE` row
     * and qualifies for an overdraft only through its subscription status.
     */
    async recordActiveStripeSubscription(organizationId: string): Promise<void> {
        await this.db.billingCustomer.update({
            where: { organizationId },
            data: {
                stripeCustomerId: `cus_${organizationId}_${Date.now()}`,
                subscriptionId: `sub_${organizationId}_${Date.now()}`,
                subscriptionStatus: SubscriptionStatus.active,
            },
        });
    }

    /** A PreviewkitEnvironment row for the usage-meter sweep tests, uniquely named per call. */
    async createPreviewkitEnvironment(input: CreatePreviewkitEnvironmentInput): Promise<CreatedPreviewkitEnvironment> {
        const seq = this.previewkitEnvironmentSeq++;
        const namespace = `preview-test-org-repo-pr-${seq}`;

        const env = await this.db.previewkitEnvironment.create({
            data: {
                organizationId: input.organizationId,
                namespace,
                repoFullName: REPO_FULL_NAME,
                githubRepositoryId: REPOSITORY_ID,
                prNumber: seq,
                headSha: `sha-${seq}`,
                headRef: `branch-${seq}`,
                status: input.status ?? PreviewkitStatus.ready,
                meteredAt: input.meteredAt,
                deployedAt: input.deployedAt ?? new Date(0),
                tornDownAt: input.tornDownAt,
            },
        });

        return { id: env.id, organizationId: env.organizationId, namespace: env.namespace };
    }

    /**
     * The topology app a build belongs to. An app build FKs an app row, so a usage
     * fixture needs a real application and preview config behind it - created once
     * per organization and reused, the way one repository's apps share a config.
     */
    async createPreviewkitApp(organizationId: string, name: string): Promise<string> {
        const configId = await this.previewkitConfigFor(organizationId);

        const app = await this.db.previewkitApp.upsert({
            where: { configId_name: { configId, name } },
            create: {
                configId,
                position: this.previewkitAppSeq++,
                name,
                repository: REPO_FULL_NAME,
                path: ".",
                port: 3000,
                resourcesTier: "medium",
            },
            update: {},
            select: { id: true },
        });

        return app.id;
    }

    private async previewkitConfigFor(organizationId: string): Promise<string> {
        const application = await this.db.application.upsert({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId: REPOSITORY_ID } },
            create: {
                organizationId,
                githubRepositoryId: REPOSITORY_ID,
                name: "Billing App",
                slug: "billing-app",
                architecture: ApplicationArchitecture.WEB,
            },
            update: {},
            select: { id: true },
        });

        const config = await this.db.previewkitConfig.upsert({
            where: { applicationId: application.id },
            create: { applicationId: application.id },
            update: {},
            select: { id: true },
        });

        return config.id;
    }
}
