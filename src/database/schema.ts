import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, date, foreignKey, index, integer, jsonb,
  pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });
const identity = (name: string) => bigint(name, { mode: "bigint" });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  baleUserId: identity("bale_user_id").notNull().unique(),
  privateChatId: identity("private_chat_id"),
  username: text("username"),
  displayName: text("display_name"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  lastSeenAt: time("last_seen_at"),
});

export const teachers = pgTable("teachers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id).unique(),
  displayName: text("display_name").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  disabledAt: time("disabled_at"),
});

export const students = pgTable("students", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => teachers.id),
  userId: uuid("user_id").references(() => users.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  disabledAt: time("disabled_at"),
  bindingRevision: bigint("binding_revision", { mode: "number" }).notNull().default(0),
}, (table) => [
  unique("students_teacher_id_id_unique").on(table.teacherId, table.id),
  uniqueIndex("students_teacher_user_unique").on(table.teacherId, table.userId).where(sql`${table.userId} IS NOT NULL`),
  check("students_names_nonempty", sql`length(trim(${table.firstName})) > 0 AND length(trim(${table.lastName})) > 0`),
]);

export const assistants = pgTable("assistants", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => teachers.id),
  userId: uuid("user_id").references(() => users.id),
  displayName: text("display_name").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  disabledAt: time("disabled_at"),
  bindingRevision: bigint("binding_revision", { mode: "number" }).notNull().default(0),
}, (table) => [
  unique("assistants_teacher_id_id_unique").on(table.teacherId, table.id),
  uniqueIndex("assistants_teacher_user_unique").on(table.teacherId, table.userId).where(sql`${table.userId} IS NOT NULL`),
]);

export const classes = pgTable("classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => teachers.id),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  disabledAt: time("disabled_at"),
}, (table) => [
  unique("classes_teacher_id_id_unique").on(table.teacherId, table.id),
  uniqueIndex("classes_active_name_unique").on(table.teacherId, table.normalizedName).where(sql`${table.disabledAt} IS NULL`),
  check("classes_name_nonempty", sql`length(trim(${table.name})) > 0`),
]);

export const classMemberships = pgTable("class_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull(),
  classId: uuid("class_id").notNull(),
  studentId: uuid("student_id").notNull(),
  joinedAt: time("joined_at").notNull().defaultNow(),
  leftAt: time("left_at"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
}, (table) => [
  foreignKey({ columns: [table.teacherId, table.classId], foreignColumns: [classes.teacherId, classes.id] }),
  foreignKey({ columns: [table.teacherId, table.studentId], foreignColumns: [students.teacherId, students.id] }),
  uniqueIndex("memberships_active_unique").on(table.classId, table.studentId).where(sql`${table.leftAt} IS NULL`),
  index("memberships_class_interval_idx").on(table.classId, table.joinedAt, table.leftAt),
  index("memberships_student_interval_idx").on(table.studentId, table.joinedAt, table.leftAt),
  check("memberships_interval_valid", sql`${table.leftAt} IS NULL OR ${table.leftAt} > ${table.joinedAt}`),
]);

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => teachers.id),
  studentId: uuid("student_id"),
  assistantId: uuid("assistant_id"),
  codeDigest: text("code_digest").notNull().unique(),
  issuedByUserId: uuid("issued_by_user_id").notNull().references(() => users.id),
  createdAt: time("created_at").notNull().defaultNow(),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
  consumedByUserId: uuid("consumed_by_user_id").references(() => users.id),
  revokedAt: time("revoked_at"),
  targetBindingRevision: bigint("target_binding_revision", { mode: "number" }).notNull(),
}, (table) => [
  foreignKey({ columns: [table.teacherId, table.studentId], foreignColumns: [students.teacherId, students.id] }),
  foreignKey({ columns: [table.teacherId, table.assistantId], foreignColumns: [assistants.teacherId, assistants.id] }),
  uniqueIndex("invitations_open_student_unique").on(table.studentId).where(sql`${table.studentId} IS NOT NULL AND ${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  uniqueIndex("invitations_open_assistant_unique").on(table.assistantId).where(sql`${table.assistantId} IS NOT NULL AND ${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  check("invitations_one_target", sql`(${table.studentId} IS NULL) <> (${table.assistantId} IS NULL)`),
  check("invitations_consumer_pair", sql`(${table.consumedAt} IS NULL) = (${table.consumedByUserId} IS NULL)`),
  check("invitations_not_revoked_and_used", sql`${table.revokedAt} IS NULL OR ${table.consumedAt} IS NULL`),
  check("invitations_expiry_valid", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const fileAssets = pgTable("file_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => teachers.id),
  kind: text("kind").notNull(),
  mimeType: text("mime_type"),
  originalName: text("original_name"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  providerFileId: text("provider_file_id"),
  storageKey: text("storage_key"),
  status: text("status").notNull().default("pending"),
  createdAt: time("created_at").notNull().defaultNow(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  checksum: text("checksum"),
}, (table) => [
  unique("assets_teacher_id_id_unique").on(table.teacherId, table.id),
  check("assets_status_valid", sql`${table.status} IN ('pending','ready','failed','purged')`),
  check("assets_size_valid", sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`),
]);

export const homeworks = pgTable("homeworks", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull(),
  classId: uuid("class_id").notNull(),
  studentId: uuid("student_id").notNull(),
  schoolDate: date("school_date").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  currentVersionId: uuid("current_version_id").notNull(),
  deletedAt: time("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
}, (table) => [
  unique("homeworks_teacher_id_id_unique").on(table.teacherId, table.id),
  foreignKey({ columns: [table.teacherId, table.classId], foreignColumns: [classes.teacherId, classes.id] }),
  foreignKey({ columns: [table.teacherId, table.studentId], foreignColumns: [students.teacherId, students.id] }),
  index("homeworks_report_idx").on(table.teacherId, table.classId, table.schoolDate, table.studentId),
  check("homeworks_deletion_pair", sql`(${table.deletedAt} IS NULL) = (${table.deletedByUserId} IS NULL)`),
]);

export const homeworkVersions = pgTable("homework_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  homeworkId: uuid("homework_id").notNull().references(() => homeworks.id),
  versionNo: integer("version_no").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  operationId: uuid("operation_id").notNull().unique(),
}, (table) => [
  uniqueIndex("versions_homework_no_unique").on(table.homeworkId, table.versionNo),
  unique("versions_homework_id_unique").on(table.homeworkId, table.id),
  index("versions_history_idx").on(table.homeworkId, table.versionNo),
  check("versions_kind_valid", sql`${table.kind} IN ('submitted','edited','deleted')`),
  check("versions_no_valid", sql`${table.versionNo} >= 1`),
  check("versions_title_nonempty", sql`length(trim(${table.title})) > 0`),
]);

export const homeworkVersionFiles = pgTable("homework_version_files", {
  teacherId: uuid("teacher_id").notNull(),
  homeworkId: uuid("homework_id").notNull(),
  versionId: uuid("version_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.versionId, table.position] }),
  foreignKey({ columns: [table.homeworkId, table.versionId], foreignColumns: [homeworkVersions.homeworkId, homeworkVersions.id] }),
  foreignKey({ columns: [table.teacherId, table.homeworkId], foreignColumns: [homeworks.teacherId, homeworks.id] }),
  foreignKey({ columns: [table.teacherId, table.assetId], foreignColumns: [fileAssets.teacherId, fileAssets.id] }),
  check("version_files_position_valid", sql`${table.position} >= 1`),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").references(() => teachers.id),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  occurredAt: time("occurred_at").notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
}, (table) => [index("audit_entity_idx").on(table.teacherId, table.entityType, table.entityId, table.occurredAt)]);

export const botSessions = pgTable("bot_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  chatId: identity("chat_id").notNull(),
  teacherId: uuid("teacher_id").references(() => teachers.id),
  role: text("role"),
  state: text("state").notNull().default("IDLE"),
  context: jsonb("context").notNull().default({}),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  expiresAt: time("expires_at").notNull(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sessions_user_chat_unique").on(table.userId, table.chatId),
  index("sessions_expiry_idx").on(table.expiresAt),
]);

export const callbackActions = pgTable("callback_actions", {
  tokenDigest: text("token_digest").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  chatId: identity("chat_id").notNull(),
  teacherId: uuid("teacher_id").references(() => teachers.id),
  action: text("action").notNull(),
  payload: jsonb("payload").notNull().default({}),
  expectedRevision: bigint("expected_revision", { mode: "number" }),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
});

export const homeworkDrafts = pgTable("homework_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull(),
  studentId: uuid("student_id").notNull(),
  classId: uuid("class_id").notNull(),
  sessionId: uuid("session_id").notNull().references(() => botSessions.id),
  schoolDate: date("school_date").notNull(),
  homeworkId: uuid("homework_id").references(() => homeworks.id),
  baseVersionId: uuid("base_version_id").references(() => homeworkVersions.id),
  title: text("title"),
  status: text("status").notNull().default("open"),
  operationId: uuid("operation_id").notNull().unique(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  expiresAt: time("expires_at").notNull(),
  committedHomeworkId: uuid("committed_homework_id").references(() => homeworks.id),
}, (table) => [
  unique("drafts_teacher_id_id_unique").on(table.teacherId, table.id),
  uniqueIndex("drafts_open_session_unique").on(table.sessionId).where(sql`${table.status} = 'open'`),
  foreignKey({ columns: [table.teacherId, table.studentId], foreignColumns: [students.teacherId, students.id] }),
  foreignKey({ columns: [table.teacherId, table.classId], foreignColumns: [classes.teacherId, classes.id] }),
  check("drafts_status_valid", sql`${table.status} IN ('open','committed','cancelled','expired')`),
  check("drafts_edit_pair", sql`(${table.homeworkId} IS NULL) = (${table.baseVersionId} IS NULL)`),
]);

export const draftFiles = pgTable("draft_files", {
  teacherId: uuid("teacher_id").notNull(),
  draftId: uuid("draft_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.draftId, table.position] }),
  foreignKey({ columns: [table.teacherId, table.draftId], foreignColumns: [homeworkDrafts.teacherId, homeworkDrafts.id] }),
  foreignKey({ columns: [table.teacherId, table.assetId], foreignColumns: [fileAssets.teacherId, fileAssets.id] }),
  check("draft_files_position_valid", sql`${table.position} >= 1`),
]);

export const feedbacks = pgTable("feedbacks", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull(),
  homeworkId: uuid("homework_id").notNull(),
  versionId: uuid("version_id").notNull(),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  authorRole: text("author_role").notNull(),
  authorDisplayName: text("author_display_name").notNull(),
  kind: text("kind").notNull(),
  body: text("body"),
  voiceAssetId: uuid("voice_asset_id"),
  createdAt: time("created_at").notNull().defaultNow(),
  operationId: uuid("operation_id").notNull().unique(),
}, (table) => [
  foreignKey({ columns: [table.teacherId, table.homeworkId], foreignColumns: [homeworks.teacherId, homeworks.id] }),
  foreignKey({ columns: [table.homeworkId, table.versionId], foreignColumns: [homeworkVersions.homeworkId, homeworkVersions.id] }),
  foreignKey({ columns: [table.teacherId, table.voiceAssetId], foreignColumns: [fileAssets.teacherId, fileAssets.id] }),
  index("feedbacks_homework_created_idx").on(table.homeworkId, table.createdAt),
  check("feedbacks_role_valid", sql`${table.authorRole} IN ('teacher','assistant')`),
  check("feedbacks_content_valid", sql`(${table.kind} = 'text' AND length(trim(${table.body})) > 0 AND ${table.voiceAssetId} IS NULL) OR (${table.kind} = 'voice' AND ${table.body} IS NULL AND ${table.voiceAssetId} IS NOT NULL)`),
]);

export const dailyReports = pgTable("daily_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => teachers.id),
  schoolDate: date("school_date").notNull(),
  closedAt: time("closed_at").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  policyVersion: text("policy_version").notNull(),
  classSummaries: jsonb("class_summaries").notNull().default([]),
}, (table) => [
  uniqueIndex("daily_reports_teacher_day_unique").on(table.teacherId, table.schoolDate),
  unique("daily_reports_teacher_id_id_unique").on(table.teacherId, table.id),
]);

export const dailyReportEntries = pgTable("daily_report_entries", {
  teacherId: uuid("teacher_id").notNull(),
  reportId: uuid("report_id").notNull(),
  classId: uuid("class_id").notNull(),
  studentId: uuid("student_id").notNull(),
  studentNameSnapshot: text("student_name_snapshot").notNull(),
  classNameSnapshot: text("class_name_snapshot").notNull(),
  submitted: boolean("submitted").notNull(),
  activeHomeworkCount: integer("active_homework_count").notNull(),
  hadDeletedHomework: boolean("had_deleted_homework").notNull(),
  accountConnectedSnapshot: boolean("account_connected_snapshot"),
}, (table) => [
  primaryKey({ columns: [table.reportId, table.classId, table.studentId] }),
  foreignKey({ columns: [table.teacherId, table.reportId], foreignColumns: [dailyReports.teacherId, dailyReports.id] }),
  foreignKey({ columns: [table.teacherId, table.classId], foreignColumns: [classes.teacherId, classes.id] }),
  foreignKey({ columns: [table.teacherId, table.studentId], foreignColumns: [students.teacherId, students.id] }),
  index("daily_entries_report_idx").on(table.reportId, table.submitted, table.classId),
  check("daily_entries_count_valid", sql`${table.activeHomeworkCount} >= 0 AND ${table.submitted} = (${table.activeHomeworkCount} > 0)`),
]);

export const processedUpdates = pgTable("processed_updates", {
  botInstanceKey: text("bot_instance_key").notNull(),
  updateId: identity("update_id").notNull(),
  status: text("status").notNull().default("pending"),
  receivedAt: time("received_at").notNull().defaultNow(),
  processedAt: time("processed_at"),
  attempts: integer("attempts").notNull().default(0),
  leaseUntil: time("lease_until"),
  lastError: text("last_error"),
  payload: jsonb("payload").notNull(),
}, (table) => [
  primaryKey({ columns: [table.botInstanceKey, table.updateId] }),
  index("processed_updates_ready_idx").on(table.status, table.leaseUntil),
]);

export const outboxMessages = pgTable("outbox_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").references(() => teachers.id),
  dailyReportId: uuid("daily_report_id").references(() => dailyReports.id),
  feedbackId: uuid("feedback_id").references(() => feedbacks.id),
  recipientUserId: uuid("recipient_user_id").references(() => users.id),
  targetStudentId: uuid("target_student_id").references(() => students.id),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
  leaseUntil: time("lease_until"),
  sentAt: time("sent_at"),
  providerMessageId: text("provider_message_id"),
  lastErrorCode: text("last_error_code"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  index("outbox_ready_idx").on(table.status, table.nextAttemptAt),
  check("outbox_status_valid", sql`${table.status} IN ('pending','processing','sent','retry','failed','unknown','cancelled')`),
]);

export const schedulerState = pgTable("scheduler_state", {
  jobName: text("job_name").primaryKey(),
  lastCompletedSchoolDate: date("last_completed_school_date"),
  updatedAt: time("updated_at").notNull().defaultNow(),
});
