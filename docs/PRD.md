# Mashqban — Product Requirements Document

- Version: 1.0 (MVP baseline)
- Prepared: 1405/09/04 in the Solar Hijri calendar (2026-11-25)
- Status: Product requirements approved; open technical decisions identified.
- Related documents: [BOT_UX.md](BOT_UX.md), [DATABASE.md](DATABASE.md), [ARCHITECTURE.md](ARCHITECTURE.md)

## 1. How to read and implement this document

- **Requirement:** A decision confirmed in discussion with the product owner, or its direct consequence. Do not change it without the owner's approval.
- **MVP proposal:** A design choice filling in details the product owner has not explicitly specified. Treat it as the implementation default unless it conflicts with a requirement.
- **Open / decision required:** A matter deliberately deferred until implementation. For decisions affecting data durability or external contracts, record the owner's decision before implementing dependent functionality.
- This document is the reference for product behavior. BOT_UX defines the user experience, DATABASE the proposed data model, and ARCHITECTURE the infrastructure and development strategy. PRD takes precedence in conflicts. `AGENTS.md` defines working practices and coding rules; report conflicts rather than silently changing product requirements.

## 2. Product definition

Mashqban is a Persian-language Bale Messenger bot for collecting daily homework, managing classes, and tracking student participation. Students enter their own homework titles and send the associated files. Teachers do not define assignments in advance and are not required to grade or approve every submission. Assistants help teachers view information and provide feedback.

Initial capacity: one teacher, approximately 100 students, and several classes; there is no fixed business limit on assistant count. Data structures and permissions must support adding teachers in the future without data leakage. This does not introduce open teacher registration or an administrator role into the MVP.

### Goals

- Simple homework submission and editing within the Bale bot, without a web panel.
- Let teachers and assistants see who has and has not submitted homework in each class.
- Preserve edit and deletion history for authorized staff without showing earlier versions in the student view.
- Send optional text or voice feedback to individual students and automatic end-of-day reports to teachers and assistants.

### Outside the MVP scope

A web panel, administrator role, open registration, teacher-defined assignments, subject categories, grades, mandatory approval, a formal revision-request workflow, class-specific deadlines, holiday exceptions, late submissions, per-submission staff notifications, parent notifications, payments, and competitive rankings. Weekly and monthly reports are requested manually.

## 3. Roles and permissions (RBAC)

| Operation | Owning teacher | Active assistant of that teacher | Student |
|---|---|---|---|
| View and manage the owner's classes | Full access | View | Own authorized classes only |
| Create, edit, and deactivate classes | Yes | No | No |
| Manage student roster and class membership | Yes | No (view only) | No |
| Create, revoke, and reissue student invitations | Yes | No | No |
| Rebind a student's account | Yes | No | No |
| Manage and invite assistants | Yes | No | No |
| View current homework and version/deletion history | Yes | Yes | Own latest active version only |
| Submit, edit, and delete files or homework | May delete; may not submit on a student's behalf | No | Own records only, within that day's window |
| Record and send text/voice feedback | Yes | Yes | No |
| View relevant feedback | Yes | Yes | Feedback addressed to that student only |
| Request daily/weekly/monthly reports | Yes | Yes | No |
| Receive automatic end-of-day reports | Yes | Yes | No |

Assistants have Read-only + Feedback access; sending feedback is the sole exception to read-only access. Each teacher's data is limited to that teacher and their active assistants. Students must not see other students' data, class reports, deleted versions, or others' invitation codes. Enforce authorization in the backend, not merely by hiding buttons.

## 4. Identity, invitations, and membership

### FR-01 — Teacher bootstrap

- Identify the initial teacher using `TEACHER_BALE_ID` in the deployment environment. Unknown users cannot assign themselves the teacher role.
- **MVP proposal:** Bootstrap is idempotent. Changing the environment ID must not silently transfer the existing owner's account; identity migration requires a deliberate procedure.

### FR-02 — Student roster

- The teacher first specifies the student's first name, last name, and authorized classes; the system generates a unique internal ID. A phone number or Bale username is not required for enrollment.
- Students may belong to multiple classes. Only teachers assign classes.
- A student remains on the teacher's roster even without a linked account.
- **MVP proposal:** Deleting a class/student or ending membership should deactivate the record so historical records and reports survive. Invitation/account-binding status is separate from membership status.

### FR-03 — Invitations and account binding

- Generate a dedicated single-use code for a previously created student record. Entering a valid code and successfully binding the account activates access; there is no independent registration.
- Each student record is linked to only one Bale account at a time. Identity uses the stable `bale_user_id`, not the mutable `username`.
- Reusing a code or linking a second account to an already linked record is prohibited. Changing a display username must not change the binding.
- When a student changes accounts, the teacher revokes the previous binding and issues a new invitation. Homework, feedback, and memberships remain attached to the same internal record. The old account immediately loses access.
- **MVP proposal:** Codes are cryptographically random, unguessable, revocable, expiring (default seven days, technically configurable), and single-use through atomic consumption. Do not store or log raw codes after issuance. Reissuing invalidates previous invitations for the same record. Rate-limit failed attempts.
- These restrictions establish account identity, not definitive real-world identity. If a teacher deliberately creates two independent records for one person, the system cannot prove duplication without a national/school ID. MVP proposal: forbid linking one account to two student records under the same teacher; similar names trigger only a warning.

### FR-04 — Assistants

Teachers create assistant records and dedicated invitations. There is no business limit on their number. Inactive assistants must not access data through old menus or callbacks. MVP proposal: a display name and account binding suffice; reissuing invitations and changing accounts follow the same secure rules as for students.

## 5. Homework and timing

### FR-05 — Time rules

- Every day of the year is active, including Fridays and holidays.
- The fixed time zone is `Asia/Tehran`; the allowed window is `[14:00, 22:00)` Tehran time. Exactly 14:00 is allowed; 22:00 and later are not.
- Determine the homework date from the local Tehran day. Store event timestamps in UTC and display dates in the Solar Hijri calendar.
- The restriction applies to students submitting, editing, removing files, and deleting entire homework records. Students cannot change homework from a previous day.
- If a workflow begins before 22:00 but is finalized at or after 22:00, do not record the homework/new version; preserve the previous valid version. Final eligibility uses authoritative server time during the save operation, not the user's device time or the message's initial receipt time.
- Viewing, staff feedback, and teacher administration are not subject to this time restriction.

### FR-06 — Homework submission

1. The student selects Submit homework and chooses an authorized class.
2. The system checks the time window and active membership.
3. The student enters a free-text homework title; there are no predefined categories or assignments.
4. The student sends one or more files of types supported by the Bale API: photos, videos, voice messages, documents, and other receivable/retrievable types.
5. The student selects Finalize. After revalidation, the system saves the homework atomically and sends a success message.

A student may create multiple independent homework records for one class on one day; the title is not a unique key. Drafts, incomplete uploads, and failed saves do not count in reports. MVP proposal: the trimmed title must be nonempty and at most 120 characters; each active version needs at least one valid file. Decide file size/count limits after checking the API and storage capacity.

### FR-07 — Editing and versioning

- Students may remove a particular file from today's homework or add a new one. Unchanged files remain without reuploading.
- Each confirmed edit creates a new version containing the complete current file set (a snapshot); previous versions and file differences are preserved.
- Teachers and assistants clearly see current and old versions, added/removed files, and modification times.
- Students see only the latest active version of their own homework in the bot. This requirement concerns the system view; the bot may not be able to remove files previously sent or received in Bale chat history.
- MVP proposal: allow title edits together with file edits. Removing the last file must not allow saving a fileless version; the student must add a file or delete the entire homework. Leaving without final confirmation does not change the current version.

### FR-08 — Deletion

- Students may delete their own homework on the same day within the allowed window. Teachers may delete homework belonging to students in their classes; assistants may not.
- Student deletion is a soft delete. Authorized staff can view all versions and deleted files, with the actor, time, and deletion status clearly identified.
- Deleted homework is absent from the normal student view. Deleting all active homework for the day makes the student a non-submitter in the report.
- MVP proposal: teacher deletion is also soft. Whole-homework deletion records a deletion event/version. The MVP has no direct restore operation; physical deletion follows the as-yet-undecided retention policy.

## 6. Feedback

### FR-09 — Optional individual feedback

- Teachers or assistants select a particular student's homework and send a text or voice message. Feedback on every homework record, grading, and approval are not required.
- Deliver feedback to the target student through the same bot. Clearly identify the homework title, class, and sender's display identity/role.
- Save feedback in history and attach it to the homework and version the staff member viewed. Editing the homework does not remove feedback.
- Students can edit only until 22:00 that same day, even if feedback arrives after the deadline. Feedback does not extend the deadline.
- MVP proposal: require sender confirmation; record delivery state (queued/API-accepted/failed/unknown) and allow controlled retries. Display old feedback text/audio without giving students links to old homework versions. Recorded feedback cannot be edited or deleted in the MVP.

## 7. Reporting

### FR-10 — Participation criteria

The reporting unit is “student × class × local Tehran day.” A student with at least one saved, non-deleted homework record in that class on that day is a submitter; the number of homework records or versions does not affect this criterion. Assess each class independently for students with multiple memberships. Submitting only in class A means non-submission in class B.

- Daily reports: counts and names of submitters and non-submitters by class/date, with staff access to the relevant homework.
- Weekly reports: Saturday through Friday; days with/without submissions per student and total eligible class opportunities.
- Monthly reports: the first through last day of a Solar Hijri month, not a rolling 30 days or a Gregorian month; use the weekly report's criteria.
- **MVP proposal:** Participation percentage = opportunities with a submission / all eligible opportunities × 100. Show “No data” when the denominator is zero. Today's report is provisional before 22:00. Do not count future days as missed submissions. For the current week/month, show finalized statistics through the last closed day and today's provisional statistics separately.
- **MVP proposal:** A student is eligible for a day if membership was active during any part of the 14:00–22:00 window or they have valid homework that day. A member deactivated before the window with no homework is excluded from the denominator. Account-binding status does not exclude active membership: uninvited/unlinked students can be non-submitters. Exclude days before membership. Preserve membership history.
- **MVP proposal:** Finalize the historical daily report at the end of the window. Administrative deletion after the day closes appears in homework history but does not silently rewrite that day's official statistics. This proposal prevents discrepancies between daily and monthly reports; explicitly change it if the owner wants live historical reporting.

### FR-11 — End-of-day notification

- Every day after 22:00 Tehran time, automatically send a report to the teacher and all their active assistants. Summarize submitter/non-submitter counts by class and provide access to the lists.
- Homework submissions and edits do not automatically notify staff. Weekly/monthly reports are manual. User replies and feedback delivery to students are exempt from this restriction.
- Recover missed reports after outages/restarts through durable scheduling. Use a logical unique key for each date, teacher, and recipient. If the API outcome is unknown, duplicate-free delivery cannot be guaranteed without Bale-side idempotency support; ARCHITECTURE defines the duplication-control policy.

## 8. Non-functional requirements

| ID | Requirement or proposed target |
|---|---|
| NFR-01 | All MVP interactions occur in private bot chats, in Persian with Solar Hijri dates; no public web interface. |
| NFR-02 | Authorize every query/command, including stale callbacks and tampered IDs; isolate classes and owners. |
| NFR-03 | Audit sensitive operations (invitations, rebinding, membership changes, deletion, new versions, feedback) with actor ID and time; no raw codes or tokens in logs. |
| NFR-04 | Conversation state and committed data survive restarts; duplicate updates must not create duplicate versions or feedback. |
| NFR-05 | Initial capacity target: 100 students; proposed concurrency test: 20 submission flows using synthetic data and a mock API. |
| NFR-06 | Student files and information are private: minimize data, enforce access control, keep secure backups, and avoid real data in tests. Define retention and final deletion policies before release. |
| NFR-07 | Network, upload, delivery, and validation failures produce actionable Persian messages; do not expose technical details or secrets to users. |

## 9. Key acceptance criteria

| ID | Scenario | Expected result |
|---|---|---|
| AC-01 | User enters without an invitation or with a consumed code | Access denied; no data disclosed. |
| AC-02 | Two accounts consume one student's code concurrently | Exactly one binding succeeds; the other is rejected. |
| AC-03 | Teacher changes a student's account | Old account immediately blocked; new account retains the same history. |
| AC-04 | Assistant tampers with a deletion or membership callback | Operation rejected; valid feedback remains allowed. |
| AC-05 | Student belongs to A and B but submits only in A | Submitter in A; non-submitter in B. |
| AC-06 | Save at 13:59:59, 14:00, 21:59:59, and 22:00 | Reject, accept, accept, reject respectively, using authoritative final-save time. |
| AC-07 | Edit begins at 21:59 and is confirmed after 22:00 | New version rejected; previous version remains valid. |
| AC-08 | Remove one file and add another | Atomic new version; staff see both versions and differences; student sees only the current version. |
| AC-09 | Student deletes the day's last active homework | Non-submitter in the daily report; staff retain history. |
| AC-10 | Voice feedback targets an old version/specific homework | Correct recipient, preserved version association, visible feedback history without exposing old homework versions to students. |
| AC-11 | Membership begins mid-month | Days before membership excluded from the denominator. |
| AC-12 | Weekly/monthly report crosses a week, year, or Solar Hijri month boundary | Correct Saturday–Friday and actual Solar Hijri month boundaries. |
| AC-13 | Server is down at 22:00 and later restarts | Missed report recovered with delivery state recorded. |
| AC-14 | Inactive assistant or user outside the class has an old link/callback | New access denied. |
| AC-15 | Update repeats or Finalize is pressed twice | Exactly one business effect is committed. |
| AC-16 | Invalid file, DB failure, or cancellation before save | Incomplete homework excluded from statistics; previous version preserved. |

## 10. Decisions and remaining checks before dependent implementation

1. **Owner decision (2026-11-25):** Store homework and feedback files in private server storage. Define backup, retention, limits, and recovery before release.
2. Initial transport choice: Long Polling for the single-instance MVP, based on the official Bale API documentation; validate with a test bot before activation. See [BALE_API_SPIKE.md](BALE_API_SPIKE.md).
3. Verify exact file types, media-group behavior, size/count limits, download/resending, API rates, and callback capabilities against the actual API; do not assume full Telegram compatibility.
4. **Owner decision (2026-11-25):** Retain homework and feedback files until one year after 31 Shahrivar, the end of their school year. Define safe deletion, consent and notices, storage, backups, and recovery targets before release.
5. This document's MVP proposals—especially report finalization, mid-day membership eligibility, invitation expiry, and teacher soft deletion—are proposals, not separate explicit owner approvals. If changed, update all four documents together.
