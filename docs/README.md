# Documentation Index

This index explains which docs are current references vs historical phase snapshots.

## Start here (current)

1. `README.md`
- Primary plugin documentation: install, usage, runtime behavior, API, env vars, troubleshooting.

2. `docs/ADMIN_MERGE_BRIEF.md`
- Merge/review summary for upstream maintainers and admins.

3. `docs/PHASE_H_VALIDATION.md`
- Final validation matrix and production readiness evidence.

4. `codextesting.md`
- Live/manual test checklist for local verification with Codex/OpenCode.

5. `docs/CUSTOM_API_SERVICE_PRD.md`
- Fork-specific PRD and implementation plan for turning the OpenCode plugin logic into a reusable API service.

## Historical phase records (context, not source of truth)

- `docs/QA.md`
- `docs/PHASE_REVIEW.md`
- `docs/PRODUCTION_READINESS.md`

These files capture intermediate milestones and may include statuses that were true at the time but later superseded.

## Rule of precedence

When documents disagree:

1. `README.md` (current behavior)
2. `docs/PHASE_H_VALIDATION.md` (final validation)
3. Historical phase docs (for timeline/context only)

## Updating docs after code changes

1. Update `README.md` for any user-visible behavior changes.
2. Update `docs/ADMIN_MERGE_BRIEF.md` for reviewer-facing deltas.
3. Update `codextesting.md` if test steps or expected output changed.
4. Add a short note in `docs/PHASE_H_VALIDATION.md` if validation scope/results changed materially.
5. Update `docs/CUSTOM_API_SERVICE_PRD.md` when service requirements, implementation status, or integration targets change.
