-- AlterTable
ALTER TABLE "billing_customer" ADD COLUMN     "kill_jobs_on_credit_exhaustion" BOOLEAN NOT NULL DEFAULT false;
