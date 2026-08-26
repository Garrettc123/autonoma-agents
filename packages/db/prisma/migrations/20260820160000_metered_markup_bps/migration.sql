-- AlterTable
ALTER TABLE "billing_pricing" ADD COLUMN     "metered_markup_bps" INTEGER NOT NULL DEFAULT 10000;
