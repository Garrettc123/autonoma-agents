-- CreateEnum
CREATE TYPE "branch_trigger_block_reason" AS ENUM ('insufficient_credits');

-- AlterTable
ALTER TABLE "branch" ADD COLUMN     "last_blocked_at" TIMESTAMP(3),
ADD COLUMN     "last_blocked_reason" "branch_trigger_block_reason";
