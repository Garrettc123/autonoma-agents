-- CreateEnum
CREATE TYPE "auto_top_up_failure_reason" AS ENUM ('no_payment_method', 'payment_declined');

-- AlterTable
ALTER TABLE "billing_customer" ADD COLUMN     "auto_top_up_last_failure_reason" "auto_top_up_failure_reason",
ADD COLUMN     "auto_top_up_last_failure_at" TIMESTAMP(3);
