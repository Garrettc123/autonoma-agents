import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

const PACKAGE_PRICE_CENTS = 5_000;
const PACKAGE_CREDITS = 75_000;

integrationTestSuite({
    name: "VercelCreditPurchaseService",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("grants the package's credits and invoices Vercel for them straight away", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            const { billingPeriodId } = await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });

            const result = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            expect(result).toEqual({
                purchased: true,
                creditsGranted: PACKAGE_CREDITS,
                priceCents: PACKAGE_PRICE_CENTS,
                newBalance: 1_000 + PACKAGE_CREDITS,
            });

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(1_000 + PACKAGE_CREDITS);

            const purchases = await harness.db.vercelCreditPurchase.findMany({ where: { organizationId: orgId } });
            expect(purchases).toHaveLength(1);
            expect(purchases[0]?.billingPeriodId).toBe(billingPeriodId);
            expect(purchases[0]?.priceCents).toBe(PACKAGE_PRICE_CENTS);
            expect(purchases[0]?.creditsGranted).toBe(PACKAGE_CREDITS);

            // Billed immediately, not deferred to the cycle invoice.
            expect(harness.vercelInvoiceSubmitter.submitted).toEqual([
                { purchaseId: purchases[0]?.id, installationId: expect.any(String), priceCents: PACKAGE_PRICE_CENTS },
            ]);
            const invoice = await harness.db.vercelInvoice.findFirstOrThrow({
                where: { billingPeriodId },
                select: { kind: true, amount: true, status: true },
            });
            expect(invoice.kind).toBe("purchase");
            expect(invoice.amount).toBe("50.00");
            expect(invoice.status).toBe("pending");
        });

        test("writes one ledger entry, keyed on the purchase that funds it", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });

            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            const transactions = await harness.db.creditTransaction.findMany({ where: { organizationId: orgId } });
            expect(transactions).toHaveLength(1);
            expect(transactions[0]?.type).toBe(CreditTransactionType.VERCEL_TOPUP_GRANT);
            expect(transactions[0]?.amount).toBe(PACKAGE_CREDITS);
            expect(transactions[0]?.balanceAfter).toBe(PACKAGE_CREDITS);
            expect(transactions[0]?.topupPackageId).toBe(packageId);

            const purchase = await harness.db.vercelCreditPurchase.findFirstOrThrow({
                where: { organizationId: orgId },
                select: { id: true },
            });
            expect(transactions[0]?.id).toBe(`ctr_vercel_purchase_${purchase.id}`);
        });

        test("refuses over the spend cap and grants nothing at all", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.spendCapService.updateCap(orgId, PACKAGE_PRICE_CENTS - 1);

            const result = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            expect(result).toEqual({ purchased: false, reason: "spend_cap_exceeded" });

            // A refusal must leave no trace on any of the three writes the grant makes.
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(1_000);
            expect(await harness.db.vercelCreditPurchase.count({ where: { organizationId: orgId } })).toBe(0);
            expect(await harness.db.creditTransaction.count({ where: { organizationId: orgId } })).toBe(0);
        });

        test("allows only one unpaid package at a time - this is the bound on what an org can walk away with", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });

            const first = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            const second = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            expect(first.purchased).toBe(true);
            expect(second).toEqual({ purchased: false, reason: "awaiting_payment" });

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(PACKAGE_CREDITS);
        });

        test("a sale that commits after the pre-flight check is still seen, so only one package is granted", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const { installationId, billingPeriodId } = await harness.createVercelInstallation({
                organizationId: orgId,
            });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });

            // Stages the race deterministically rather than hoping the scheduler produces it: a
            // competing sale holds the org's customer row and commits its purchase only after this
            // one has already passed its unlocked pre-flight check. The purchase must therefore
            // find out about it from the re-read inside its own locked transaction, which is the
            // only place left to catch it.
            let onLockHeld = (): void => {};
            let onGateOpen = (): void => {};
            const lockHeld = new Promise<void>((resolve) => {
                onLockHeld = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                onGateOpen = resolve;
            });

            const competingSale = harness.db.$transaction(
                async (tx) => {
                    await tx.$queryRaw`SELECT id FROM billing_customer WHERE organization_id = ${orgId} FOR UPDATE`;
                    onLockHeld();
                    await gate;
                    await tx.vercelCreditPurchase.create({
                        data: {
                            organizationId: orgId,
                            installationId,
                            billingPeriodId: billingPeriodId ?? "",
                            packageId,
                            creditsGranted: PACKAGE_CREDITS,
                            priceCents: PACKAGE_PRICE_CENTS,
                        },
                    });
                },
                { timeout: 30_000 },
            );

            await lockHeld;
            const blockedPurchase = harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            await new Promise((resolve) => setTimeout(resolve, 500));
            onGateOpen();
            await competingSale;

            expect(await blockedPurchase).toEqual({ purchased: false, reason: "awaiting_payment" });
            // The competing sale's row is the only one, and no credits were granted for a second.
            expect(await harness.db.vercelCreditPurchase.count({ where: { organizationId: orgId } })).toBe(1);
            expect(await harness.db.creditTransaction.count({ where: { organizationId: orgId } })).toBe(0);
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(0);

            // The refused purchase reserved spend before it lost; it has to hand that back or the
            // org is charged against its own ceiling for a package it never received.
            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(0);
        });

        test("the database refuses a second unpaid purchase for an org, whatever route wrote it", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const { installationId, billingPeriodId } = await harness.createVercelInstallation({
                organizationId: orgId,
            });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            const unpaidPurchase = {
                organizationId: orgId,
                installationId,
                billingPeriodId: billingPeriodId ?? "",
                packageId,
                creditsGranted: PACKAGE_CREDITS,
                priceCents: PACKAGE_PRICE_CENTS,
            };

            await harness.db.vercelCreditPurchase.create({ data: unpaidPurchase });

            // The backstop under the service's lock: credits are granted before the invoice exists,
            // so a second unpaid row is a package nobody is billed for.
            await expect(harness.db.vercelCreditPurchase.create({ data: unpaidPurchase })).rejects.toThrow();
        });

        test("a resubmission of a purchase Vercel already invoiced does not bill it a second time", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            // The shape of the bug this guards: the POST reached Vercel, the transaction that links
            // the invoice did not commit, so the sweep sees an unbilled purchase and tries again.
            const purchase = await harness.db.vercelCreditPurchase.findFirstOrThrow({
                where: { organizationId: orgId },
                select: { id: true, invoiceId: true },
            });
            await harness.db.vercelCreditPurchase.update({ where: { id: purchase.id }, data: { invoiceId: null } });
            await harness.db.vercelInvoice.delete({ where: { id: purchase.invoiceId ?? "" } });

            const result = await harness.vercelCreditPurchaseService.retryUnbilledPurchases(100);

            expect(result).toEqual({ attempted: 1, invoiced: 0 });
            // One submission for this purchase - Vercel refused the second on its `externalId`, so
            // the customer is billed once for the one package they bought.
            const submissions = harness.vercelInvoiceSubmitter.submitted.filter(
                (entry) => entry.purchaseId === purchase.id,
            );
            expect(submissions).toHaveLength(1);
            expect(await harness.db.vercelInvoice.count({ where: { installation: { organizationId: orgId } } })).toBe(
                0,
            );
        });

        test("allows the next purchase once the previous invoice is paid", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });

            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            await harness.db.vercelInvoice.updateMany({ data: { status: "paid", paidAt: new Date() } });

            const second = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            expect(second.purchased).toBe(true);
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(PACKAGE_CREDITS * 2);
        });

        test("a failed invoice submission keeps the credits but blocks the next sale until it is settled", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            harness.vercelInvoiceSubmitter.shouldFail = true;

            // The sale succeeded from the customer's side - they have the credits.
            const first = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            expect(first.purchased).toBe(true);

            const purchase = await harness.db.vercelCreditPurchase.findFirstOrThrow({
                where: { organizationId: orgId },
                select: { invoiceId: true },
            });
            expect(purchase.invoiceId).toBeNull();

            // ...but the money is still owed, so nothing more can be bought.
            harness.vercelInvoiceSubmitter.shouldFail = false;
            const second = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            expect(second).toEqual({ purchased: false, reason: "awaiting_payment" });
        });

        test("the retry sweep settles a purchase whose invoice call failed, unblocking the org", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.createVercelInstallation({ organizationId: orgId });
            harness.vercelInvoiceSubmitter.shouldFail = true;
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            harness.vercelInvoiceSubmitter.shouldFail = false;

            const result = await harness.vercelCreditPurchaseService.retryUnbilledPurchases(100);

            expect(result).toEqual({ attempted: 1, invoiced: 1 });
            const purchase = await harness.db.vercelCreditPurchase.findFirstOrThrow({
                where: { organizationId: orgId },
                select: { invoiceId: true },
            });
            expect(purchase.invoiceId).not.toBeNull();

            // Still unpaid, so still blocking - the retry raises the invoice, it does not settle it.
            const next = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            expect(next).toEqual({ purchased: false, reason: "awaiting_payment" });
        });

        test("the retry sweep leaves a still-failing purchase alone for the next run", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.createVercelInstallation({ organizationId: orgId });
            harness.vercelInvoiceSubmitter.shouldFail = true;
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            const result = await harness.vercelCreditPurchaseService.retryUnbilledPurchases(100);

            expect(result).toEqual({ attempted: 1, invoiced: 0 });
            const purchase = await harness.db.vercelCreditPurchase.findFirstOrThrow({
                where: { organizationId: orgId },
                select: { invoiceId: true },
            });
            expect(purchase.invoiceId).toBeNull();
        });

        // A plan carrying no payment method still gets invoiced - Vercel owns collecting against it,
        // and the one-unpaid-purchase bound is what limits an org that never settles to a single
        // package. Refusing the sale instead would leave a free-plan org with no way to buy at all.
        test("sells to a plan that requires no payment method, and invoices it anyway", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId, paymentMethodRequired: false });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });

            const result = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            expect(result).toMatchObject({ purchased: true, creditsGranted: PACKAGE_CREDITS });
            const purchase = await harness.db.vercelCreditPurchase.findFirstOrThrow({
                where: { organizationId: orgId },
                select: { invoiceId: true },
            });
            expect(purchase.invoiceId).not.toBeNull();
        });

        test("refuses when there is no active billing period to attach the charge to", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId, withActivePeriod: false });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });

            await expect(harness.vercelCreditPurchaseService.purchase(orgId, packageId)).rejects.toThrow(
                /billing period/i,
            );
            expect(await harness.db.creditTransaction.count({ where: { organizationId: orgId } })).toBe(0);
        });

        test("refuses an org that is not billed through Vercel", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });

            await expect(harness.vercelCreditPurchaseService.purchase(orgId, packageId)).rejects.toThrow(
                /not billed through Vercel/i,
            );
        });

        test("refuses a deactivated package, so a retired price cannot still be bought", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.billingService.setTopupPackageActive(packageId, false);

            await expect(harness.vercelCreditPurchaseService.purchase(orgId, packageId)).rejects.toThrow(
                /not available/i,
            );
            expect(await harness.db.creditTransaction.count({ where: { organizationId: orgId } })).toBe(0);
        });

        // This rail grants before it collects, so a refund that only marked the invoice would be a
        // way to keep the credits for free.
        test("takes the credits back when Vercel refunds the purchase invoice", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            const invoice = await harness.db.vercelInvoice.findFirstOrThrow({
                where: { installation: { organizationId: orgId } },
                select: { vercelInvoiceId: true },
            });
            await harness.vercelCreditPurchaseService.revokeForRefundedInvoice(invoice.vercelInvoiceId);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(1_000);

            // The cap headroom the purchase consumed comes back with the money.
            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(0);
        });

        // Webhooks are retried, and a second revoke would take the credits twice.
        test("revoking the same refunded invoice twice takes the credits once", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            const invoice = await harness.db.vercelInvoice.findFirstOrThrow({
                where: { installation: { organizationId: orgId } },
                select: { vercelInvoiceId: true },
            });
            await harness.vercelCreditPurchaseService.revokeForRefundedInvoice(invoice.vercelInvoiceId);
            await harness.vercelCreditPurchaseService.revokeForRefundedInvoice(invoice.vercelInvoiceId);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(1_000);
        });

        // The cap reversal subtracts, so a retried webhook that reversed it twice would hand back
        // headroom the org never bought - and go on spending it. An unrelated charge sits underneath
        // the purchase here because a reversal past zero is clamped, which would hide the second
        // subtraction entirely.
        test("revoking the same refunded invoice twice reopens the cap headroom once", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            const unrelatedChargeCents = PACKAGE_PRICE_CENTS * 2;
            await harness.spendCapService.recordManualCharge(orgId, unrelatedChargeCents);
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            const invoice = await harness.db.vercelInvoice.findFirstOrThrow({
                where: { installation: { organizationId: orgId } },
                select: { vercelInvoiceId: true },
            });
            await harness.vercelCreditPurchaseService.revokeForRefundedInvoice(invoice.vercelInvoiceId);
            await harness.vercelCreditPurchaseService.revokeForRefundedInvoice(invoice.vercelInvoiceId);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(unrelatedChargeCents);
        });

        // An org that already spent the credits keeps the work it did; the refund takes back what is
        // left rather than pushing it into a debt it did not ask for.
        test("takes back only the credits still there when the org already spent some", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { creditBalance: 500 },
            });

            const invoice = await harness.db.vercelInvoice.findFirstOrThrow({
                where: { installation: { organizationId: orgId } },
                select: { vercelInvoiceId: true },
            });
            await harness.vercelCreditPurchaseService.revokeForRefundedInvoice(invoice.vercelInvoiceId);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(0);
        });

        // The clamp above is computed in JS and applied as a relative decrement, so it is only
        // correct if the balance it read cannot move underneath it. Staged deterministically rather
        // than left to the scheduler: a competing deduction holds the org's customer row and drains
        // the balance, committing only once the revoke is already in flight.
        test("does not drive the balance negative when a deduction lands mid-revoke", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            const invoice = await harness.db.vercelInvoice.findFirstOrThrow({
                where: { installation: { organizationId: orgId } },
                select: { vercelInvoiceId: true },
            });

            let onLockHeld = (): void => {};
            let onGateOpen = (): void => {};
            const lockHeld = new Promise<void>((resolve) => {
                onLockHeld = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                onGateOpen = resolve;
            });

            const competingDeduction = harness.db.$transaction(
                async (tx) => {
                    await tx.$queryRaw`SELECT id FROM billing_customer WHERE organization_id = ${orgId} FOR UPDATE`;
                    onLockHeld();
                    await gate;
                    await tx.billingCustomer.update({
                        where: { organizationId: orgId },
                        data: { creditBalance: 300 },
                    });
                },
                { timeout: 30_000 },
            );

            await lockHeld;
            const revoke = harness.vercelCreditPurchaseService.revokeForRefundedInvoice(invoice.vercelInvoiceId);
            await new Promise((resolve) => setTimeout(resolve, 500));
            onGateOpen();
            await competingDeduction;
            await revoke;

            // Takes back what is left, not what was granted: 300, not the package's full 150,000.
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(0);
        });

        // A refunded invoice is resolved, not outstanding - otherwise one refund locks the org out of
        // buying ever again, since nothing moves that invoice back to paid.
        test("lets an org buy again after a purchase was refunded", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await harness.createVercelInstallation({ organizationId: orgId });
            const packageId = await harness.createTopupPackage({
                priceCents: PACKAGE_PRICE_CENTS,
                creditsGranted: PACKAGE_CREDITS,
            });
            await harness.vercelCreditPurchaseService.purchase(orgId, packageId);

            const invoice = await harness.db.vercelInvoice.findFirstOrThrow({
                where: { installation: { organizationId: orgId } },
                select: { id: true },
            });
            await harness.db.vercelInvoice.update({ where: { id: invoice.id }, data: { status: "refunded" } });

            const second = await harness.vercelCreditPurchaseService.purchase(orgId, packageId);
            expect(second).toMatchObject({ purchased: true });
        });
    },
});
