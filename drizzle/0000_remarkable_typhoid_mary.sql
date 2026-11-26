CREATE TABLE "assistants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"binding_revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "assistants_teacher_id_id_unique" UNIQUE("teacher_id","id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid,
	"actor_user_id" uuid,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"teacher_id" uuid,
	"role" text,
	"state" text DEFAULT 'IDLE' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "callback_actions" (
	"token_digest" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"teacher_id" uuid,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected_revision" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "class_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "memberships_interval_valid" CHECK ("class_memberships"."left_at" IS NULL OR "class_memberships"."left_at" > "class_memberships"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "classes_teacher_id_id_unique" UNIQUE("teacher_id","id"),
	CONSTRAINT "classes_name_nonempty" CHECK (length(trim("classes"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_report_entries" (
	"teacher_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"student_name_snapshot" text NOT NULL,
	"class_name_snapshot" text NOT NULL,
	"submitted" boolean NOT NULL,
	"active_homework_count" integer NOT NULL,
	"had_deleted_homework" boolean NOT NULL,
	"account_connected_snapshot" boolean,
	CONSTRAINT "daily_report_entries_report_id_class_id_student_id_pk" PRIMARY KEY("report_id","class_id","student_id"),
	CONSTRAINT "daily_entries_count_valid" CHECK ("daily_report_entries"."active_homework_count" >= 0 AND "daily_report_entries"."submitted" = ("daily_report_entries"."active_homework_count" > 0))
);
--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"school_date" date NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"policy_version" text NOT NULL,
	"class_summaries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "daily_reports_teacher_id_id_unique" UNIQUE("teacher_id","id")
);
--> statement-breakpoint
CREATE TABLE "draft_files" (
	"teacher_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "draft_files_draft_id_position_pk" PRIMARY KEY("draft_id","position"),
	CONSTRAINT "draft_files_position_valid" CHECK ("draft_files"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "feedbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"homework_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_role" text NOT NULL,
	"author_display_name" text NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"voice_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid NOT NULL,
	CONSTRAINT "feedbacks_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "feedbacks_role_valid" CHECK ("feedbacks"."author_role" IN ('teacher','assistant')),
	CONSTRAINT "feedbacks_content_valid" CHECK (("feedbacks"."kind" = 'text' AND length(trim("feedbacks"."body")) > 0 AND "feedbacks"."voice_asset_id" IS NULL) OR ("feedbacks"."kind" = 'voice' AND "feedbacks"."body" IS NULL AND "feedbacks"."voice_asset_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "file_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text,
	"original_name" text,
	"size_bytes" bigint,
	"provider_file_id" text,
	"storage_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"checksum" text,
	CONSTRAINT "assets_teacher_id_id_unique" UNIQUE("teacher_id","id"),
	CONSTRAINT "assets_status_valid" CHECK ("file_assets"."status" IN ('pending','ready','failed','purged')),
	CONSTRAINT "assets_size_valid" CHECK ("file_assets"."size_bytes" IS NULL OR "file_assets"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "homework_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"school_date" date NOT NULL,
	"homework_id" uuid,
	"base_version_id" uuid,
	"title" text,
	"status" text DEFAULT 'open' NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_homework_id" uuid,
	CONSTRAINT "homework_drafts_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "drafts_teacher_id_id_unique" UNIQUE("teacher_id","id"),
	CONSTRAINT "drafts_status_valid" CHECK ("homework_drafts"."status" IN ('open','committed','cancelled','expired')),
	CONSTRAINT "drafts_edit_pair" CHECK (("homework_drafts"."homework_id" IS NULL) = ("homework_drafts"."base_version_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "homework_version_files" (
	"teacher_id" uuid NOT NULL,
	"homework_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "homework_version_files_version_id_position_pk" PRIMARY KEY("version_id","position"),
	CONSTRAINT "version_files_position_valid" CHECK ("homework_version_files"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "homework_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"homework_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	CONSTRAINT "homework_versions_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "versions_homework_id_unique" UNIQUE("homework_id","id"),
	CONSTRAINT "versions_kind_valid" CHECK ("homework_versions"."kind" IN ('submitted','edited','deleted')),
	CONSTRAINT "versions_no_valid" CHECK ("homework_versions"."version_no" >= 1),
	CONSTRAINT "versions_title_nonempty" CHECK (length(trim("homework_versions"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "homeworks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"school_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_version_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	CONSTRAINT "homeworks_teacher_id_id_unique" UNIQUE("teacher_id","id"),
	CONSTRAINT "homeworks_deletion_pair" CHECK (("homeworks"."deleted_at" IS NULL) = ("homeworks"."deleted_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"student_id" uuid,
	"assistant_id" uuid,
	"code_digest" text NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"target_binding_revision" bigint NOT NULL,
	CONSTRAINT "invitations_code_digest_unique" UNIQUE("code_digest"),
	CONSTRAINT "invitations_one_target" CHECK (("invitations"."student_id" IS NULL) <> ("invitations"."assistant_id" IS NULL)),
	CONSTRAINT "invitations_consumer_pair" CHECK (("invitations"."consumed_at" IS NULL) = ("invitations"."consumed_by_user_id" IS NULL)),
	CONSTRAINT "invitations_not_revoked_and_used" CHECK ("invitations"."revoked_at" IS NULL OR "invitations"."consumed_at" IS NULL),
	CONSTRAINT "invitations_expiry_valid" CHECK ("invitations"."expires_at" > "invitations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid,
	"daily_report_id" uuid,
	"feedback_id" uuid,
	"recipient_user_id" uuid,
	"target_student_id" uuid,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "outbox_status_valid" CHECK ("outbox_messages"."status" IN ('pending','processing','sent','retry','failed','unknown','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "processed_updates" (
	"bot_instance_key" text NOT NULL,
	"update_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"payload" jsonb NOT NULL,
	CONSTRAINT "processed_updates_bot_instance_key_update_id_pk" PRIMARY KEY("bot_instance_key","update_id")
);
--> statement-breakpoint
CREATE TABLE "scheduler_state" (
	"job_name" text PRIMARY KEY NOT NULL,
	"last_completed_school_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"user_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"binding_revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "students_teacher_id_id_unique" UNIQUE("teacher_id","id"),
	CONSTRAINT "students_names_nonempty" CHECK (length(trim("students"."first_name")) > 0 AND length(trim("students"."last_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "teachers_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bale_user_id" bigint NOT NULL,
	"private_chat_id" bigint,
	"username" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_bale_user_id_unique" UNIQUE("bale_user_id")
);
--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_actions" ADD CONSTRAINT "callback_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_actions" ADD CONSTRAINT "callback_actions_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_memberships" ADD CONSTRAINT "class_memberships_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_memberships" ADD CONSTRAINT "class_memberships_teacher_id_class_id_classes_teacher_id_id_fk" FOREIGN KEY ("teacher_id","class_id") REFERENCES "public"."classes"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_memberships" ADD CONSTRAINT "class_memberships_teacher_id_student_id_students_teacher_id_id_fk" FOREIGN KEY ("teacher_id","student_id") REFERENCES "public"."students"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_report_entries" ADD CONSTRAINT "daily_report_entries_teacher_id_report_id_daily_reports_teacher_id_id_fk" FOREIGN KEY ("teacher_id","report_id") REFERENCES "public"."daily_reports"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_report_entries" ADD CONSTRAINT "daily_report_entries_teacher_id_class_id_classes_teacher_id_id_fk" FOREIGN KEY ("teacher_id","class_id") REFERENCES "public"."classes"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_report_entries" ADD CONSTRAINT "daily_report_entries_teacher_id_student_id_students_teacher_id_id_fk" FOREIGN KEY ("teacher_id","student_id") REFERENCES "public"."students"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_files" ADD CONSTRAINT "draft_files_teacher_id_draft_id_homework_drafts_teacher_id_id_fk" FOREIGN KEY ("teacher_id","draft_id") REFERENCES "public"."homework_drafts"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_files" ADD CONSTRAINT "draft_files_teacher_id_asset_id_file_assets_teacher_id_id_fk" FOREIGN KEY ("teacher_id","asset_id") REFERENCES "public"."file_assets"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_teacher_id_homework_id_homeworks_teacher_id_id_fk" FOREIGN KEY ("teacher_id","homework_id") REFERENCES "public"."homeworks"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_homework_id_version_id_homework_versions_homework_id_id_fk" FOREIGN KEY ("homework_id","version_id") REFERENCES "public"."homework_versions"("homework_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_teacher_id_voice_asset_id_file_assets_teacher_id_id_fk" FOREIGN KEY ("teacher_id","voice_asset_id") REFERENCES "public"."file_assets"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_drafts" ADD CONSTRAINT "homework_drafts_session_id_bot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_drafts" ADD CONSTRAINT "homework_drafts_homework_id_homeworks_id_fk" FOREIGN KEY ("homework_id") REFERENCES "public"."homeworks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_drafts" ADD CONSTRAINT "homework_drafts_base_version_id_homework_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."homework_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_drafts" ADD CONSTRAINT "homework_drafts_committed_homework_id_homeworks_id_fk" FOREIGN KEY ("committed_homework_id") REFERENCES "public"."homeworks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_drafts" ADD CONSTRAINT "homework_drafts_teacher_id_student_id_students_teacher_id_id_fk" FOREIGN KEY ("teacher_id","student_id") REFERENCES "public"."students"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_drafts" ADD CONSTRAINT "homework_drafts_teacher_id_class_id_classes_teacher_id_id_fk" FOREIGN KEY ("teacher_id","class_id") REFERENCES "public"."classes"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_version_files" ADD CONSTRAINT "homework_version_files_homework_id_version_id_homework_versions_homework_id_id_fk" FOREIGN KEY ("homework_id","version_id") REFERENCES "public"."homework_versions"("homework_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_version_files" ADD CONSTRAINT "homework_version_files_teacher_id_homework_id_homeworks_teacher_id_id_fk" FOREIGN KEY ("teacher_id","homework_id") REFERENCES "public"."homeworks"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_version_files" ADD CONSTRAINT "homework_version_files_teacher_id_asset_id_file_assets_teacher_id_id_fk" FOREIGN KEY ("teacher_id","asset_id") REFERENCES "public"."file_assets"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_versions" ADD CONSTRAINT "homework_versions_homework_id_homeworks_id_fk" FOREIGN KEY ("homework_id") REFERENCES "public"."homeworks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homework_versions" ADD CONSTRAINT "homework_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homeworks" ADD CONSTRAINT "homeworks_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homeworks" ADD CONSTRAINT "homeworks_teacher_id_class_id_classes_teacher_id_id_fk" FOREIGN KEY ("teacher_id","class_id") REFERENCES "public"."classes"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homeworks" ADD CONSTRAINT "homeworks_teacher_id_student_id_students_teacher_id_id_fk" FOREIGN KEY ("teacher_id","student_id") REFERENCES "public"."students"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_consumed_by_user_id_users_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_teacher_id_student_id_students_teacher_id_id_fk" FOREIGN KEY ("teacher_id","student_id") REFERENCES "public"."students"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_teacher_id_assistant_id_assistants_teacher_id_id_fk" FOREIGN KEY ("teacher_id","assistant_id") REFERENCES "public"."assistants"("teacher_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_daily_report_id_daily_reports_id_fk" FOREIGN KEY ("daily_report_id") REFERENCES "public"."daily_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_feedback_id_feedbacks_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedbacks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_target_student_id_students_id_fk" FOREIGN KEY ("target_student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistants_teacher_user_unique" ON "assistants" USING btree ("teacher_id","user_id") WHERE "assistants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("teacher_id","entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_user_chat_unique" ON "bot_sessions" USING btree ("user_id","chat_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "bot_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_active_unique" ON "class_memberships" USING btree ("class_id","student_id") WHERE "class_memberships"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "memberships_class_interval_idx" ON "class_memberships" USING btree ("class_id","joined_at","left_at");--> statement-breakpoint
CREATE INDEX "memberships_student_interval_idx" ON "class_memberships" USING btree ("student_id","joined_at","left_at");--> statement-breakpoint
CREATE UNIQUE INDEX "classes_active_name_unique" ON "classes" USING btree ("teacher_id","normalized_name") WHERE "classes"."disabled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "daily_entries_report_idx" ON "daily_report_entries" USING btree ("report_id","submitted","class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_reports_teacher_day_unique" ON "daily_reports" USING btree ("teacher_id","school_date");--> statement-breakpoint
CREATE INDEX "feedbacks_homework_created_idx" ON "feedbacks" USING btree ("homework_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_open_session_unique" ON "homework_drafts" USING btree ("session_id") WHERE "homework_drafts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "versions_homework_no_unique" ON "homework_versions" USING btree ("homework_id","version_no");--> statement-breakpoint
CREATE INDEX "versions_history_idx" ON "homework_versions" USING btree ("homework_id","version_no");--> statement-breakpoint
CREATE INDEX "homeworks_report_idx" ON "homeworks" USING btree ("teacher_id","class_id","school_date","student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_student_unique" ON "invitations" USING btree ("student_id") WHERE "invitations"."student_id" IS NOT NULL AND "invitations"."consumed_at" IS NULL AND "invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_assistant_unique" ON "invitations" USING btree ("assistant_id") WHERE "invitations"."assistant_id" IS NOT NULL AND "invitations"."consumed_at" IS NULL AND "invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_ready_idx" ON "outbox_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "processed_updates_ready_idx" ON "processed_updates" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "students_teacher_user_unique" ON "students" USING btree ("teacher_id","user_id") WHERE "students"."user_id" IS NOT NULL;