-- An app that accepts no inbound connections (a worker, poller, or queue consumer)
-- has no port to declare. Widening only: every existing row keeps its value, and a
-- reader compiled against the old non-null type still sees a number for all of them.
ALTER TABLE "previewkit_app" ALTER COLUMN "port" DROP NOT NULL;
ALTER TABLE "previewkit_app_instance" ALTER COLUMN "port" DROP NOT NULL;
