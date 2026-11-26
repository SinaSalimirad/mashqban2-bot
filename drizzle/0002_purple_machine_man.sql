CREATE TABLE "invitation_attempts" (
	"bale_user_id" bigint PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invitation_attempts_count_nonnegative" CHECK ("invitation_attempts"."attempt_count" >= 0)
);
