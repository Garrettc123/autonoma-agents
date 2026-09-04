-- Owner-authored knowledge about an application, one row per memory (see the model's doc comment
-- in schema.prisma).
--
-- APPLY EITHER SIDE OF THE DEPLOY. Nothing reads or writes this table yet; rows are authored by
-- hand through the upsert script in apps/api.
--
-- No separate index on application_id: the (application_id, slug) unique index leads with it and
-- serves every per-application lookup.

-- CreateTable
CREATE TABLE "application_memory" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "application_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_memory_organization_id_idx" ON "application_memory"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_memory_application_id_slug_key" ON "application_memory"("application_id", "slug");

-- AddForeignKey
ALTER TABLE "application_memory" ADD CONSTRAINT "application_memory_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_memory" ADD CONSTRAINT "application_memory_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
