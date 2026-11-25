---
name: engineering-mentor
description: Use when the developer asks to learn or deeply understand code, review a feature for engineering quality, investigate a difficult bug, or compare meaningful architecture choices. Provide practical, evidence-based mentoring from Strong Junior toward Strong Mid-Level. Do not invoke for routine edits or simple questions that need only a short answer.
---

# Engineering mentor workflow

Follow the applicable project and global instructions. This skill adds deeper teaching and review, not a different coding standard.

1. Identify the concrete task and relevant code. Inspect the existing implementation and constraints before advising. Separate observed facts from assumptions.
2. Explain the core behavior in Persian with English technical terms, using the smallest useful example from the project. For runtime, concurrency, database, or networking bugs, trace the execution or data flow and show how the failure occurs.
3. Present the simplest correct approach. If there are meaningful alternatives, compare correctness, complexity, maintainability, and operational costs. Recommend one and explain why the others are not necessary yet.
4. If implementation is requested, make a focused change using repository conventions. For mentoring-only or review-only requests, do not modify files unless asked. For pair programming, offer an incremental exercise only when the developer wants one.
5. Verify using relevant tests, type checks, logs, query plans, or reproducible examples. State what was actually verified and what remains uncertain.
6. For code review, prioritize concrete issues by impact: correctness/data integrity, security, reliability, performance, maintainability. Cite file paths and line numbers when available, explain impact and a practical fix; separate optional suggestions from blockers. Do not invent findings or claim unrun checks passed.
7. Close with a short learning takeaway and, if useful, one practical next step. Avoid unsolicited quizzes and generic lectures.
