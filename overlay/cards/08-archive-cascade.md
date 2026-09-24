---
id: 08-archive-cascade
title: Archiving clears a visible session tree
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork issue #14 and commits b138ee9a, dece5c76
---

## Outcome

An authorized user can archive any visible session, including bot-created, automation-created, and
agent-spawned sessions. Archiving retires the selected session and its complete descendant tree,
stops active or wedged work, and keeps the entire archived lineage out of the sidebar immediately
and after refetch.

## Observable behavior

- Archiving a root or a descendant immediately removes that session and all of its descendants from
  the sidebar, and none return after refetch.
- The selected session, its children, and all deeper descendants become archived, whether they were
  linked manually or spawned by an agent.
- Active execution and work stuck in pending or processing stop before the affected session is
  archived. Cancelled, terminal, and already-archived sessions do not block the operation.
- A descendant whose ancestor is archived stays hidden even if that descendant remains active. It is
  neither shown under the archived ancestor nor promoted to a top-level row.
- A descendant whose parent was deleted or is excluded by the Mine filter still re-roots and remains
  visible.
- Unrelated sessions and non-archived sibling trees remain visible and unchanged.
- With 14,000 sessions and archived ancestors in the lineage, loading the active inbox remains under
  one second rather than regressing into multi-second recursive work.
- A canonical user authorized for a visible bot-, automation-, or agent-rooted session can archive
  it even when the recorded actor identity differs from the user's canonical identity.
- The same canonical user can rename or unarchive the session without first joining it as a
  participant.
- Queued messages settle visibly with an archive reason and cannot resume during recovery.
- Public requests retain their existing contract: malformed requests return 400, missing sessions
  return 404, and unauthorized callers return 403. Actionable client errors expose a safe reason;
  unexpected failures and server-error responses remain generic.

## Durable constraints

- Archive applies recursively to the complete selected subtree from every archive entrypoint.
- Visibility follows lineage: any archived ancestor hides all descendants, while deleted parents and
  parents excluded only by the Mine filter do not.
- One unavailable descendant adds no more than five seconds before reachable siblings and the
  selected session continue.
- Archive, unarchive, and rename authorization must recognize the canonical owner of visible bot-,
  automation-, and agent-created sessions without granting access to genuine non-participants or to
  a caller possessing only a WebSocket token.
- Public authorization boundaries and error statuses must not be weakened by descendant processing.
