-- Removes the aws recipe's service-enable flag columns. The flags live in the
-- service's `options` since the fold migration, which is where every release from
-- here reads them; the release the fold shipped with also mirrored them back into
-- these columns so a rollback stayed safe, and this drops the columns once that
-- mirror is the only writer left.
--
-- APPLY AFTER DEPLOYING - the release being replaced still declares the columns on
-- the Prisma model, and service rows are read without a `select`, so Prisma names
-- every scalar column: dropping them early breaks every preview-config read.
ALTER TABLE "previewkit_config_service" DROP COLUMN "s3";
ALTER TABLE "previewkit_config_service" DROP COLUMN "sqs";
ALTER TABLE "previewkit_config_service" DROP COLUMN "sns";
