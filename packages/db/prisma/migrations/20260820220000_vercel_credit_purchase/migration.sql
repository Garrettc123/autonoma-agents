-- AlterTable
ALTER TABLE "vercel_invoice" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'cycle';

-- CreateTable
CREATE TABLE "vercel_credit_purchase" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "billing_period_id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "credits_granted" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "invoice_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vercel_credit_purchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vercel_credit_purchase_invoice_id_key" ON "vercel_credit_purchase"("invoice_id");

-- CreateIndex
CREATE INDEX "vercel_credit_purchase_organization_id_idx" ON "vercel_credit_purchase"("organization_id");

-- CreateIndex
CREATE INDEX "vercel_credit_purchase_installation_id_idx" ON "vercel_credit_purchase"("installation_id");

-- CreateIndex
CREATE INDEX "vercel_credit_purchase_billing_period_id_idx" ON "vercel_credit_purchase"("billing_period_id");

-- AddForeignKey
ALTER TABLE "vercel_credit_purchase" ADD CONSTRAINT "vercel_credit_purchase_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_credit_purchase" ADD CONSTRAINT "vercel_credit_purchase_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "vercel_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_credit_purchase" ADD CONSTRAINT "vercel_credit_purchase_billing_period_id_fkey" FOREIGN KEY ("billing_period_id") REFERENCES "vercel_billing_period"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_credit_purchase" ADD CONSTRAINT "vercel_credit_purchase_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "billing_topup_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vercel_credit_purchase" ADD CONSTRAINT "vercel_credit_purchase_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "vercel_invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
