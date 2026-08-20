---
id: 19-orphan-subtask-hidden
title: Orphaned sub-tasks stay out of the sidebar
type: rebuild
priority: high
placement: upstream-code
depends_on: [08-archive-cascade]
origin: fork; issue #14 lineage; display-side complement to card 08
discussion: https://github.com/mauricedesaxe/background-agents/issues/328
---

## Requirement

A session whose ancestor chain includes an archived session does not appear in the sidebar. Not as a
nested child, and above all not promoted to a top-level row. This is the display-side complement to
card `08-archive-cascade`: the cascade archives a parent's children on the write side, but it is
**best-effort** (an unreachable or never-created child DO is logged, not retried), and sessions
created before the cascade existed predate it. So active children of an archived parent exist in the
data. Upstream's inbox re-roots any subtree whose ancestor is not eligible, which promotes these
orphans to standalone top-level rows (the fork already badges them "sub-task"). The user archived
the parent precisely to clear that subtree, so seeing its children resurface loose at the top is the
bug.

The fix is narrow and must not overreach: re-rooting a subtree whose ancestor is hidden by the
**creator / automation filter** (a non-archived parent excluded by the Mine view) is intended and
stays — that is how the Mine view keeps showing your own descendant work under someone else's root.
Only an **archived** ancestor (or an archived-lineage ancestor) hides the subtree. A parent that was
hard-deleted keeps its existing re-root behavior too; archived is the one case that hides.

## Acceptance test (the contract)

Parent archived while its child and grandchild stay active -> the inbox returns neither the child
nor the grandchild, as a root or as a descendant, in any category. A sibling non-archived hierarchy
is untouched and still returned. Re-rooting still fires for a **deleted** parent and for a parent
hidden by the **Mine** filter (both non-archived). Covered by an integration test through the real
inbox query in workerd, alongside the existing deleted-parent and filtered-parent re-root tests that
must keep passing.

## Placement decision (durable)

- Rebuilt in the **upstream-owned inbox query**, reapplied each sync. Upstream owns and actively
  develops this query, so expect the re-rooting CTE to move; re-locate it and re-apply the
  archived-lineage exclusion against whatever the query looks like on the day.
- **No migration.** It rides the existing `parent_session_id` / `status` columns.
- Server-side only. The client cannot distinguish a legitimate re-rooted root from an orphan,
  because the server presents both as roots. The exclusion has to happen where roots are computed.

## Dated evidence (2026-08-20, non-binding hints)

- An `archived_lineage` recursive CTE (descendants of any `status = 'archived'` parent) whose ids
  are excluded from `eligible_sessions`, in `packages/control-plane/src/db/session-inbox-store.ts`
  (`inboxCtes`). The re-rooting CTE it guards is `rerooted_sessions` in the same builder.
- Test: `packages/control-plane/test/integration/session-inbox.test.ts`, case "hides an active
  sub-task whose ancestor is archived".
