-- One row per GitHub repository we have stored anything about: the identity the eight tables
-- carrying a `repo_full_name` will migrate onto, so a rename stops needing a fan-out across all
-- of them.
--
-- APPLY EITHER SIDE OF THE DEPLOY. Nothing reads this table yet. The release that follows writes
-- it (RepoRenameService keeps `full_name` current on a rename, and ensureRepository upserts rows
-- on demand), but no read path depends on it and no existing column changes, so the old release
-- keeps working unchanged and this can be applied before or after it.
--
-- The seed keys on `full_name` because that is the only identifier the existing rows carry: seven
-- of the eight tables store the name and no numeric id. A consequence worth knowing before you
-- read the row count: a repository renamed BEFORE this migration lands has rows under two names,
-- so it seeds as TWO rows here. That is not a seeding fault - it is the only measurement we will
-- ever get of how much damage the un-invalidated rename bug already did. The query to read it off
-- is in apps/api/README.md.

-- CreateTable
CREATE TABLE "github_repository" (
    "id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "github_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_repository_full_name_key" ON "github_repository"("full_name");

-- CreateIndex
CREATE UNIQUE INDEX "github_repository_github_id_key" ON "github_repository"("github_id");

-- Seed one row per distinct name across every table that denormalizes it. gen_random_uuid() is
-- only generating a unique primary key here, not a cuid: Prisma's @default(cuid()) applies to rows
-- the client creates, and nothing reads meaning out of this column.
INSERT INTO "github_repository" ("id", "full_name", "updated_at")
SELECT gen_random_uuid()::text, "full_name", CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT "repo_full_name" AS "full_name" FROM "github_pr_comment"
    UNION
    SELECT DISTINCT "repo_full_name" FROM "github_check_run"
    UNION
    SELECT DISTINCT "repo_full_name" FROM "branch_contributor"
    UNION
    SELECT DISTINCT "repo_full_name" FROM "skip_record"
    UNION
    SELECT DISTINCT "repo_full_name" FROM "bug_fix_outcome"
    UNION
    SELECT DISTINCT "repo_full_name" FROM "finding_false_positive_candidate"
    UNION
    SELECT DISTINCT "repo_full_name" FROM "previewkit_build_circuit"
    UNION
    SELECT DISTINCT "repo_full_name" FROM "previewkit_environment"
) AS "names"
ON CONFLICT ("full_name") DO NOTHING;

-- Backfill the numeric id where an existing row already knows it. previewkit_environment is the
-- only table holding both a name and a github_repository_id, and it is nullable there, so this
-- covers repos that have had a preview and leaves the rest null until a webhook or API read
-- supplies one.
--
-- DISTINCT ON the NUMERIC ID rather than the name, which is load-bearing: `github_id` is uniquely
-- indexed, and a repository renamed before this migration has environments under both names
-- carrying the SAME id. Keyed by name, both names would claim that id in one statement - each
-- passing any "is it taken" check, because a single UPDATE sees one snapshot - and the migration
-- would die on the unique index. One row per id, newest name first, makes that impossible: the
-- pre-rename name keeps its rows and simply stays null here.
UPDATE "github_repository" AS "r"
SET "github_id" = "src"."github_repository_id"
FROM (
    SELECT DISTINCT ON ("github_repository_id")
        "github_repository_id",
        "repo_full_name"
    FROM "previewkit_environment"
    WHERE "github_repository_id" IS NOT NULL
    ORDER BY "github_repository_id", "created_at" DESC
) AS "src"
WHERE "r"."full_name" = "src"."repo_full_name"
  AND "r"."github_id" IS NULL;
