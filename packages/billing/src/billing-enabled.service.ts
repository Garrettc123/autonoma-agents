import type { ApplicationArchitecture, PrismaClient } from "@autonoma/db";
import type { BillingTopupSource } from "@autonoma/types";
import { AutoTopUpService } from "./auto-topup.service";
import { BillingCustomerService } from "./billing-customer.service";
import { BillingPricingService } from "./billing-pricing.service";
import { BillingPromoService } from "./billing-promo.service";
import { BillingTopupPackageService } from "./billing-topup-package.service";
import { CreditsService } from "./credits.service";
import { LoggingBillingAlertNotifier } from "./logging-billing-alert-notifier";
import { SpendCapService } from "./spend-cap.service";
import type {
    BillingService,
    BillingServiceOptions,
    CreateTopupPackageInput,
    DeductGenerationContext,
    StripeBillingService,
    UpdateTopupPackageInput,
} from "./types";
import { VercelOverageService } from "./vercel-overage.service";

export class EnabledBillingService implements BillingService, StripeBillingService {
    private readonly billingCustomerService: BillingCustomerService;
    private readonly creditsService: CreditsService;
    private readonly billingPricingService: BillingPricingService;
    private readonly billingPromoService: BillingPromoService;
    private readonly vercelOverageService: VercelOverageService;
    private readonly topupPackageService: BillingTopupPackageService;
    private readonly spendCapService: SpendCapService;

    constructor(db: PrismaClient, options: BillingServiceOptions = {}) {
        const alertNotifier = options.alertNotifier ?? new LoggingBillingAlertNotifier();
        this.billingPricingService = new BillingPricingService(db);
        this.topupPackageService = new BillingTopupPackageService(db);
        this.spendCapService = new SpendCapService(db, alertNotifier);
        const autoTopUpService = new AutoTopUpService(db, this.topupPackageService, this.spendCapService);
        this.billingCustomerService = new BillingCustomerService(db, this.topupPackageService, this.spendCapService);
        this.billingPromoService = new BillingPromoService(db);
        this.vercelOverageService = new VercelOverageService(db);
        this.creditsService = new CreditsService(
            db,
            autoTopUpService,
            this.billingPricingService,
            this.vercelOverageService,
            this.topupPackageService,
            this.spendCapService,
        );
    }

    async getOrCreateCustomer(organizationId: string, orgName: string) {
        const customer = await this.billingCustomerService.getOrCreateCustomer(organizationId, orgName);
        await this.billingPricingService.getOrCreatePricing(organizationId);
        return customer;
    }

    createCheckoutSession(organizationId: string, returnPath?: string, packageId?: string) {
        return this.billingCustomerService.createCheckoutSession(organizationId, returnPath, packageId);
    }

    createPortalSession(organizationId: string, returnPath?: string) {
        return this.billingCustomerService.createPortalSession(organizationId, returnPath);
    }

    getBillingStatus(organizationId: string) {
        return this.billingCustomerService.getBillingStatus(organizationId);
    }

    getSubscriptionStatus(organizationId: string) {
        return this.billingCustomerService.getSubscriptionStatus(organizationId);
    }

    updateAutoTopUp(organizationId: string, enabled: boolean, threshold: number, packageId?: string) {
        return this.billingCustomerService.updateAutoTopUp(organizationId, enabled, threshold, packageId);
    }

    checkCreditsGate(organizationId: string, runCount: number, architecture: ApplicationArchitecture) {
        return this.creditsService.checkCreditsGate(organizationId, runCount, architecture);
    }

    deductCreditsForGeneration(generationId: string, context?: DeductGenerationContext) {
        return this.creditsService.deductCreditsForGeneration(generationId, context);
    }

    checkLlmProxyGate(organizationId: string, freeCliCreditCap: number) {
        return this.creditsService.checkLlmProxyGate(organizationId, freeCliCreditCap);
    }

    deductCreditsForLlmProxy(organizationId: string, costUsd: number, requestId: string) {
        return this.creditsService.deductCreditsForLlmProxy(organizationId, costUsd, requestId);
    }

    deductCreditsForPreviewUsage(
        organizationId: string,
        usageWindowId: string,
        vcpuSeconds: number,
        gbSeconds: number,
    ) {
        return this.creditsService.deductCreditsForPreviewUsage(organizationId, usageWindowId, vcpuSeconds, gbSeconds);
    }

    checkPreviewDeployCreditsGate(organizationId: string) {
        return this.creditsService.checkPreviewDeployCreditsGate(organizationId);
    }

    checkAnalysisCreditsGate(organizationId: string) {
        return this.creditsService.checkAnalysisCreditsGate(organizationId);
    }

    updateCreditFloor(organizationId: string, creditFloor: number) {
        return this.creditsService.updateCreditFloor(organizationId, creditFloor);
    }

    updateKillJobsOnCreditExhaustion(organizationId: string, killJobsOnCreditExhaustion: boolean) {
        return this.creditsService.updateKillJobsOnCreditExhaustion(organizationId, killJobsOnCreditExhaustion);
    }

    refundCreditsForGeneration(generationId: string) {
        return this.creditsService.refundCreditsForGeneration(generationId);
    }

    grantSubscriptionCredits(organizationId: string, invoiceId: string, customerEmail?: string) {
        return this.creditsService.grantSubscriptionCredits(organizationId, invoiceId, customerEmail);
    }

    startGracePeriodByOrganizationId(organizationId: string, gracePeriodDays: number) {
        return this.billingCustomerService.startGracePeriodByOrganizationId(organizationId, gracePeriodDays);
    }

    grantTopupCredits(
        organizationId: string,
        stripePaymentIntentId: string,
        packageId: string | undefined,
        source: BillingTopupSource,
        customerEmail?: string,
    ) {
        return this.creditsService.grantTopupCredits(
            organizationId,
            stripePaymentIntentId,
            packageId,
            source,
            customerEmail,
        );
    }

    revokeTopupCredits(
        organizationId: string,
        stripeRefundId: string,
        stripePaymentIntentId: string,
        refundedAmountCents: number,
        originalChargedAmountCents: number,
    ) {
        return this.creditsService.revokeTopupCredits(
            organizationId,
            stripeRefundId,
            stripePaymentIntentId,
            refundedAmountCents,
            originalChargedAmountCents,
        );
    }

    syncFromStripe(stripeCustomerId: string) {
        return this.billingCustomerService.syncFromStripe(stripeCustomerId);
    }

    findCustomerByStripeId(stripeCustomerId: string) {
        return this.billingCustomerService.findCustomerByStripeId(stripeCustomerId);
    }

    startGracePeriodByStripeCustomerId(stripeCustomerId: string, gracePeriodDays: number) {
        return this.billingCustomerService.startGracePeriodByStripeCustomerId(stripeCustomerId, gracePeriodDays);
    }

    clearGracePeriodByStripeCustomerId(stripeCustomerId: string) {
        return this.billingCustomerService.clearGracePeriodByStripeCustomerId(stripeCustomerId);
    }

    redeemPromoCode(organizationId: string, code: string) {
        return this.billingPromoService.redeemPromoCode(organizationId, code);
    }

    listPromoCodes(input?: Parameters<BillingPromoService["listPromoCodes"]>[0]) {
        return this.billingPromoService.listPromoCodes(input);
    }

    createPromoCode(input: Parameters<BillingPromoService["createPromoCode"]>[0]) {
        return this.billingPromoService.createPromoCode(input);
    }

    setPromoCodeActive(promoCodeId: string, isActive: boolean) {
        return this.billingPromoService.setPromoCodeActive(promoCodeId, isActive);
    }

    getVercelOverageStatus(organizationId: string) {
        return this.vercelOverageService.getOverageStatus(organizationId);
    }

    updateVercelOverageCap(organizationId: string, maxOverageAmountUsd: number | undefined) {
        return this.vercelOverageService.updateOverageCap(organizationId, maxOverageAmountUsd);
    }

    getPricing(organizationId: string) {
        return this.billingPricingService.getOrCreatePricing(organizationId);
    }

    updateComputePricing(
        organizationId: string,
        rates: { creditsPerVcpuHour: number; creditsPerGbMemoryHour: number },
    ) {
        return this.billingPricingService.updateComputePricing(organizationId, rates);
    }

    getComputePricingReferences() {
        return this.billingPricingService.getComputePricingReferences();
    }

    listActiveTopupPackages() {
        return this.topupPackageService.listActive();
    }

    listAllTopupPackages() {
        return this.topupPackageService.listAll();
    }

    createTopupPackage(input: CreateTopupPackageInput) {
        return this.topupPackageService.create(input);
    }

    updateTopupPackage(packageId: string, input: UpdateTopupPackageInput) {
        return this.topupPackageService.update(packageId, input);
    }

    setTopupPackageActive(packageId: string, isActive: boolean) {
        return this.topupPackageService.setActive(packageId, isActive);
    }

    getSpendCapStatus(organizationId: string) {
        return this.spendCapService.getStatus(organizationId);
    }

    updateSpendCap(organizationId: string, capAmountCents: number | undefined) {
        return this.spendCapService.updateCap(organizationId, capAmountCents);
    }
}
