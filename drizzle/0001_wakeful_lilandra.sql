ALTER TABLE "homeworks" ALTER COLUMN "current_version_id" SET NOT NULL;
--> statement-breakpoint
-- A homework and its first version are inserted in one transaction.
ALTER TABLE "homeworks" ADD CONSTRAINT "homeworks_current_version_fk"
  FOREIGN KEY ("id", "current_version_id")
  REFERENCES "homework_versions" ("homework_id", "id")
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "class_memberships" ADD CONSTRAINT "memberships_no_overlap"
  EXCLUDE USING gist (
    "class_id" WITH =,
    "student_id" WITH =,
    tstzrange("joined_at", COALESCE("left_at", 'infinity'::timestamptz), '[)') WITH &&
  );
