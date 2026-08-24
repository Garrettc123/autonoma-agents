-- CreateTable
CREATE TABLE "previewkit_build_circuit" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3),
    "alerted_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "probed_at" TIMESTAMP(3),
    "reset_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "previewkit_build_circuit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "previewkit_build_circuit_organization_id_idx" ON "previewkit_build_circuit"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "previewkit_build_circuit_organization_id_repo_full_name_app_key" ON "previewkit_build_circuit"("organization_id", "repo_full_name", "app_name");
