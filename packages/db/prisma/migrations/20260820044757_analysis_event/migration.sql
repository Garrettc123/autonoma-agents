-- CreateEnum
CREATE TYPE "analysis_event_type" AS ENUM ('commits_pushed');

-- CreateEnum
CREATE TYPE "analysis_event_source" AS ENUM ('webhook', 'label', 'comment', 'ui', 'vercel', 'ci', 'onboarding', 'mcp', 'admin', 'http');

-- CreateTable
CREATE TABLE "analysis_event" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branch_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "analysis_event_type" NOT NULL,
    "source" "analysis_event_source" NOT NULL,
    "payload" JSONB NOT NULL,
    "claimed_by_snapshot_id" TEXT,

    CONSTRAINT "analysis_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_event_branch_id_created_at_idx" ON "analysis_event"("branch_id", "created_at");

-- CreateIndex
CREATE INDEX "analysis_event_organization_id_idx" ON "analysis_event"("organization_id");

-- CreateIndex
CREATE INDEX "analysis_event_claimed_by_snapshot_id_idx" ON "analysis_event"("claimed_by_snapshot_id");

-- AddForeignKey
ALTER TABLE "analysis_event" ADD CONSTRAINT "analysis_event_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_event" ADD CONSTRAINT "analysis_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_event" ADD CONSTRAINT "analysis_event_claimed_by_snapshot_id_fkey" FOREIGN KEY ("claimed_by_snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
