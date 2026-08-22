-- Moves build-time-ness from a list of key names on the app onto the value itself.
--
-- `previewkit_app.build_secrets` named the keys a build needed; a secret row now
-- carries its own flag, which is what a connection has always done via
-- `build_time`. One less soft string reference between two tables.
--
-- APPLY BEFORE DEPLOYING. The new code reads this column, and the release it
-- replaces reads `build_secrets` - which this migration leaves in place, so both
-- work in the window between. `build_secrets` is dropped in a later release, once
-- nothing reads it.
--
-- The backfill covers every declared key that has a value. 80 of the 499 declared
-- entries have no row and so cannot be carried over: a flag on a value cannot
-- express "the build needs this and nobody supplied it". Those declarations are
-- lost here, deliberately - see the release notes.
--
-- The column is ADDED defaulting to false and only then switched to defaulting to
-- true. The order is load-bearing: adding it as `DEFAULT true` would mark all 2276
-- existing rows build-time, including the 1857 that are runtime-only today, and
-- put their values into build images for the first time. Existing rows must keep
-- exactly what `build_secrets` said; only rows written from here on get the new
-- default, which is the one the editor has always applied to a new variable.
ALTER TABLE "previewkit_secret" ADD COLUMN "build_time" BOOLEAN NOT NULL DEFAULT false;

UPDATE "previewkit_secret" AS s
SET "build_time" = true
FROM "previewkit_app" AS a
WHERE s."app_id" = a."id"
  AND s."key" = ANY (a."build_secrets");

ALTER TABLE "previewkit_secret" ALTER COLUMN "build_time" SET DEFAULT true;
