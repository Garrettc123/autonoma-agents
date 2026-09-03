import {
    ApplicationArchitecture,
    CreditTransactionType,
    type GenerationStatus,
    type PrismaClient,
    PreviewkitStatus,
    SubscriptionStatus,
    TriggerSource,
    VercelBillingPeriodStatus,
    VercelInstallationStatus,
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
import type { VercelInvoiceSubmission, VercelInvoiceSubmitter } from "../src/types";
import { VercelCreditPurchaseService } from "../src/vercel-credit-purchase.service";
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
    public readonly vercelCreditPurchaseService: VercelCreditPurchaseService;
    public readonly autoTopUpService: AutoTopUpService;
    /** Records what would have been sent to Vercel, and can be made to fail on demand. */
    public readonly vercelInvoiceSubmitter: FakeVercelInvoiceSubmitter;
    public readonly pricingService: BillingPricingService;

    private previewkitEnvironmentSeq = 0;
    private vercelInstallationSeq = 0;
    private vercelInvoiceSeq = 0;
    private previewkitAppSeq = 0;
    private generationSeq = 0;

    constructor(db: PrismaClient) {
        this.db = db;
        const alertNotifier = new LoggingBillingAlertNotifier();
        this.spendCapService = new SpendCapService(db, alertNotifier);
        this.topupPackageService = new BillingTopupPackageService(db);
        this.pricingService = new BillingPricingService(db);
        this.vercelInvoiceSubmitter = new FakeVercelInvoiceSubmitter();
        this.vercelCreditPurchaseService = new VercelCreditPurchaseService(
            db,
            this.topupPackageService,
            this.spendCapService,
            this.vercelInvoiceSubmitter,
        );
        // Mirrors the real wiring: auto top-up needs the purchase service to recharge a Vercel org,
        // since that rail settles by invoice rather than by charging a card.
        this.autoTopUpService = new AutoTopUpService(
            db,
            this.topupPackageService,
            this.spendCapService,
            this.vercelCreditPurchaseService,
        );
        this.creditsService = new CreditsService(
            db,
            this.autoTopUpService,
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
        // In-memory state, so truncating the database does not touch it.
        this.vercelInvoiceSubmitter.reset();
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
     * An active Vercel installation with an active billing period, which is what a credit purchase
     * needs to attach itself to. `paymentMethodRequired`/`initialCharge` default to a plan the
     * invoicer will actually bill - pass `paymentMethodRequired: false` to build the free plan the
     * purchase path is supposed to refuse.
     */
    async createVercelInstallation(input: {
        organizationId: string;
        paymentMethodRequired?: boolean;
        withActivePeriod?: boolean;
    }): Promise<{ installationId: string; billingPeriodId: string | undefined; planId: string }> {
        const seq = this.vercelInstallationSeq++;
        const user = await this.db.user.create({
            data: { name: `Vercel User ${seq}`, email: `vercel-user-${seq}-${Date.now()}@example.com` },
        });

        const plan = await this.db.vercelBillingPlan.create({
            data: {
                name: `Vercel Plan ${seq}-${Date.now()}`,
                description: "Test plan",
                cost: "50.00",
                initialCharge: "50.00",
                paymentMethodRequired: input.paymentMethodRequired ?? true,
                details: {},
            },
        });

        const installation = await this.db.vercelInstallation.create({
            data: {
                vercelInstallationId: `icfg_${seq}_${Date.now()}`,
                vercelAccountId: `team_${seq}`,
                vercelUserId: `vuser_${seq}`,
                organizationId: input.organizationId,
                userId: user.id,
                status: VercelInstallationStatus.active,
                billingPlanId: plan.id,
                accessTokenEnc: "encrypted-test-token",
            },
        });

        if (input.withActivePeriod === false) {
            return { installationId: installation.id, billingPeriodId: undefined, planId: plan.id };
        }

        const period = await this.db.vercelBillingPeriod.create({
            data: {
                installationId: installation.id,
                planId: plan.id,
                endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                status: VercelBillingPeriodStatus.active,
            },
        });

        return { installationId: installation.id, billingPeriodId: period.id, planId: plan.id };
    }

    /** A purchasable catalog entry, uniquely named per call. */
    async createTopupPackage(input: { priceCents: number; creditsGranted: number }): Promise<string> {
        const seq = this.vercelInstallationSeq;
        const pkg = await this.db.billingTopupPackage.create({
            data: {
                name: `Pack ${seq}-${input.creditsGranted}-${Date.now()}`,
                stripePriceId: `price_${seq}_${Date.now()}`,
                priceCents: input.priceCents,
                creditsGranted: input.creditsGranted,
            },
        });
        return pkg.id;
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
     *
     * Its installation ids carry an `_inv_` marker so they cannot collide with
     * {@link createVercelInstallation}'s: the two run off separate sequence counters, so both would
     * otherwise mint `icfg_0_<ms>` on their first call within the same millisecond.
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
                vercelInstallationId: `icfg_inv_${seq}_${Date.now()}`,
                vercelAccountId: `team_inv_${seq}`,
                vercelUserId: `vuser_inv_${seq}`,
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

    /**
     * A `TestGeneration` for the generation deduction and refund paths, which write a
     * `credit_transaction` row FK'd to one - so unlike every other fixture here they cannot be
     * exercised with a bare organization id. Creates the whole chain the FK needs (application,
     * folder, test case, plan, branch, snapshot) and returns just the generation id.
     */
    async createGeneration(organizationId: string, status: GenerationStatus = "pending"): Promise<string> {
        const seq = this.generationSeq++;
        const applicationId = await this.applicationFor(organizationId);

        // Created per call rather than reused: `Folder`'s unique key is (applicationId, parentId,
        // name), and a root folder's `parentId` is null - which Prisma refuses in a compound unique
        // `where`, so there is no upsert to do here.
        const folder = await this.db.folder.create({
            data: { organizationId, applicationId, name: `Root ${seq}` },
            select: { id: true },
        });
        const testCase = await this.db.testCase.create({
            data: {
                organizationId,
                applicationId,
                folderId: folder.id,
                name: `Checkout ${seq}`,
                slug: `checkout-${seq}`,
            },
            select: { id: true },
        });
        const testPlan = await this.db.testPlan.create({
            data: { organizationId, testCaseId: testCase.id, prompt: "Buy one item and check out" },
            select: { id: true },
        });
        const branch = await this.db.branch.create({
            data: { organizationId, applicationId, name: `feature-${seq}` },
            select: { id: true },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: TriggerSource.MANUAL },
            select: { id: true },
        });

        const generation = await this.db.testGeneration.create({
            data: { organizationId, testPlanId: testPlan.id, snapshotId: snapshot.id, status },
            select: { id: true },
        });

        return generation.id;
    }

    private async previewkitConfigFor(organizationId: string): Promise<string> {
        const applicationId = await this.applicationFor(organizationId);

        const config = await this.db.previewkitConfig.upsert({
            where: { applicationId },
            create: { applicationId },
            update: {},
            select: { id: true },
        });

        return config.id;
    }

    /** The one application every fixture in this harness hangs off, created on first use. */
    private async applicationFor(organizationId: string): Promise<string> {
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

        return application.id;
    }
}

/**
 * Stands in for Vercel's Submit Invoice API - no network, and failure is switchable. Enforces the
 * real API's uniqueness rule on `externalId` (here, the purchase id) so a test can observe what a
 * resubmission actually does rather than what the fake feels like doing.
 */
export class FakeVercelInvoiceSubmitter implements VercelInvoiceSubmitter {
    public readonly submitted: Array<{ purchaseId: string; installationId: string; priceCents: number }> = [];
    public shouldFail = false;
    private seq = 0;

    /**
     * Back to a submitter that accepts everything and has seen nothing. Called from the harness's
     * `beforeEach`, because `shouldFail` and `submitted` otherwise carry into the next test - and a
     * leaked `shouldFail` is silent: the purchase still succeeds and only the invoice is missing, so
     * the next test fails somewhere unrelated to the line that set it.
     */
    reset(): void {
        this.submitted.length = 0;
        this.shouldFail = false;
        this.seq = 0;
    }

    async submitCreditPurchaseInvoice(input: {
        purchaseId: string;
        installationId: string;
        billingPeriodId: string;
        packageName: string;
        creditsGranted: number;
        priceCents: number;
    }): Promise<VercelInvoiceSubmission> {
        if (this.shouldFail) throw new Error("Vercel invoice submission failed");
        if (this.submitted.some((entry) => entry.purchaseId === input.purchaseId)) {
            return { outcome: "already_submitted" };
        }
        this.submitted.push({
            purchaseId: input.purchaseId,
            installationId: input.installationId,
            priceCents: input.priceCents,
        });
        return { outcome: "submitted", vercelInvoiceId: `inv_test_${this.seq++}_${Date.now()}` };
    }
}
