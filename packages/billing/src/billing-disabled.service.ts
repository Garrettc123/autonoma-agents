import type { ApplicationArchitecture, PrismaClient } from "@autonoma/db";
import { BillingCustomerService } from "./billing-customer.service";
import { BillingPricingService } from "./billing-pricing.service";
import { BillingPromoService } from "./billing-promo.service";
import { BillingTopupPackageService } from "./billing-topup-package.service";
import { LoggingBillingAlertNotifier } from "./logging-billing-alert-notifier";
import { SpendCapService } from "./spend-cap.service";
import type {
    AnalysisCreditsGateResult,
    BillingService,
    CreateTopupPackageInput,
    DeductGenerationContext,
    LlmProxyGateResult,
    PreviewDeployGateResult,
    UpdateTopupPackageInput,
} from "./types";

export class DisabledBillingService implements BillingService {
    private readonly billingCustomerService: BillingCustomerService;
    private readonly billingPricingService: BillingPricingService;
    private readonly billingPromoService: BillingPromoService;
    private readonly topupPackageService: BillingTopupPackageService;
    private readonly spendCapService: SpendCapService;

    constructor(db: PrismaClient) {
        this.billingPricingService = new BillingPricingService(db);
        this.topupPackageService = new BillingTopupPackageService(db);
        this.spendCapService = new SpendCapService(db, new LoggingBillingAlertNotifier());
        this.billingCustomerService = new BillingCustomerService(db, this.topupPackageService, this.spendCapService);
        this.billingPromoService = new BillingPromoService(db);
    }

    async getOrCreateCustomer(organizationId: string, orgName: string) {
        const customer = await this.billingCustomerService.getOrCreateCustomer(organizationId, orgName);
        await this.billingPricingService.getOrCreatePricing(organizationId);
        return customer;
    }

    grantSubscriptionCredits(_organizationId: string, _invoiceId: string, _customerEmail?: string) {
        return Promise.resolve();
    }

    startGracePeriodByOrganizationId(_organizationId: string, _gracePeriodDays: number) {
        return Promise.resolve();
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

    checkCreditsGate(_organizationId: string, _runCount: number, _architecture: ApplicationArchitecture) {
        return Promise.resolve();
    }

    deductCreditsForGeneration(_generationId: string, _context?: DeductGenerationContext) {
        return Promise.resolve(false);
    }

    checkLlmProxyGate(_organizationId: string, _freeCliCreditCap: number): Promise<LlmProxyGateResult> {
        // Billing disabled means no metering and no cap - the proxy route is not
        // even mounted in this mode (it requires STRIPE_ENABLED), so this is only
        // ever reached in tests/misconfig. Allow, matching the other no-op gates.
        return Promise.resolve({ allowed: true });
    }

    deductCreditsForLlmProxy(_organizationId: string, _costUsd: number, _requestId: string) {
        return Promise.resolve(false);
    }

    deductCreditsForPreviewUsage(
        _organizationId: string,
        _usageWindowId: string,
        _vcpuSeconds: number,
        _gbSeconds: number,
    ) {
        return Promise.resolve(false);
    }

    checkPreviewDeployCreditsGate(_organizationId: string): Promise<PreviewDeployGateResult> {
        // Billing disabled means no metering and no gate - allow, matching the other no-op gates.
        return Promise.resolve({ allowed: true });
    }

    checkAnalysisCreditsGate(_organizationId: string): Promise<AnalysisCreditsGateResult> {
        return Promise.resolve({ allowed: true });
    }

    updateCreditFloor(_organizationId: string, _creditFloor: number) {
        return Promise.resolve();
    }

    updateKillJobsOnCreditExhaustion(_organizationId: string, _killJobsOnCreditExhaustion: boolean) {
        return Promise.resolve();
    }

    refundCreditsForGeneration(_generationId: string) {
        return Promise.resolve();
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

    getVercelOverageStatus(_organizationId: string) {
        return Promise.resolve({
            enabled: false,
            maxOverageAmountUsd: undefined,
            overagePricePerCredit: undefined,
            overageCreditsGrantedThisPeriod: 0,
            overageAmountUsdThisPeriod: 0,
        });
    }

    updateVercelOverageCap(_organizationId: string, _maxOverageAmountUsd: number | undefined) {
        return Promise.resolve();
    }

    getPricing(organizationId: string) {
        return this.billingPricingService.getOrCreatePricing(organizationId);
    }

    updateComputePricing(organizationId: string, rates: { usdPerVcpuHour: number; usdPerGbHour: number }) {
        return this.billingPricingService.updateComputePricing(organizationId, rates);
    }

    updateMeteredMarkup(organizationId: string, meteredMarkupBps: number) {
        return this.billingPricingService.updateMeteredMarkup(organizationId, meteredMarkupBps);
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
