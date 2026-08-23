-- Folds the aws recipe's service-enable flags into the service's `options`, where
-- the recipe's other knobs (queues, buckets, topics, subscriptions) already live.
-- The three columns were aws-only but existed on every service row: measured before
-- writing this, exactly 1 of 174 rows used them, the rest were NULL in all three.
--
-- APPLY BEFORE DEPLOYING. The new code reads the flags from `options`; without this
-- fold, the one aws service would deploy as "no services enabled" and fail. The old
-- release keeps reading the columns, which this migration leaves populated and the
-- new release keeps writing (mirrored from options - service rows are recreated on
-- every save, so without the mirror the first save would null them and a rollback
-- would deploy the aws service with nothing enabled). A follow-up drops the columns
-- and the mirror together once no release reads them.
--
-- An `options` key that already exists wins over the column, matching the parse-time
-- fold in the config schema.
UPDATE previewkit_config_service
SET options = options
    || CASE WHEN s3  IS NOT NULL AND NOT options ? 's3'  THEN jsonb_build_object('s3', s3)   ELSE '{}'::jsonb END
    || CASE WHEN sqs IS NOT NULL AND NOT options ? 'sqs' THEN jsonb_build_object('sqs', sqs) ELSE '{}'::jsonb END
    || CASE WHEN sns IS NOT NULL AND NOT options ? 'sns' THEN jsonb_build_object('sns', sns) ELSE '{}'::jsonb END
WHERE s3 IS NOT NULL OR sqs IS NOT NULL OR sns IS NOT NULL;
