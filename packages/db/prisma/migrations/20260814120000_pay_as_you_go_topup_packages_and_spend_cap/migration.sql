-- AlterTable
ALTER TABLE "billing_customer" ADD COLUMN     "auto_top_up_package_id" TEXT,
ADD COLUMN     "spend_cap_amount_cents" INTEGER;

-- AlterTable
ALTER TABLE "credit_transaction" ADD COLUMN     "billing_period_key" TEXT,
ADD COLUMN     "topup_package_id" TEXT;

-- CreateTable
CREATE TABLE "billing_topup_package" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "credits_granted" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_topup_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_topup_spend_period" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "amount_charged_cents" INTEGER NOT NULL DEFAULT 0,
    "last_alert_threshold_sent" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_topup_spend_period_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_topup_package_stripe_price_id_key" ON "billing_topup_package"("stripe_price_id");

-- CreateIndex
CREATE INDEX "billing_topup_spend_period_organization_id_idx" ON "billing_topup_spend_period"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_topup_spend_period_organization_id_period_key_key" ON "billing_topup_spend_period"("organization_id", "period_key");

-- AddForeignKey
ALTER TABLE "billing_customer" ADD CONSTRAINT "billing_customer_auto_top_up_package_id_fkey" FOREIGN KEY ("auto_top_up_package_id") REFERENCES "billing_topup_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_topup_spend_period" ADD CONSTRAINT "billing_topup_spend_period_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transaction" ADD CONSTRAINT "credit_transaction_topup_package_id_fkey" FOREIGN KEY ("topup_package_id") REFERENCES "billing_topup_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

