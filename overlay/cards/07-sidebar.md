---
id: 07-sidebar
title: Grouped session sidebar for high fan-out
type: rebuild
priority: high
placement: upstream-code
depends_on: []
origin: fork origin 0b12c30; upstream issues #20 and #21
---

## Outcome

The session sidebar remains usable under heavy fan-out by grouping sessions by repository, visually
separating manual and automatic sessions, collapsing child-session trees by default, and letting
each user manually mark a session unread.

## Observable behavior

- Sessions appear in repository groups rather than a single flat list.
- Each repository group visibly separates manual sessions from automatic sessions.
- There is no redundant Manual/Automatic source filter; the existing creator filter remains the
  filtering control.
- A parent with children has a disclosure control. Its children are hidden by default, expanding it
  reveals them, and collapsing it hides them again.
- Nested parents can be expanded and collapsed independently.
- A user can mark a session unread, and the unread state is visible only for that user.

## Durable constraints

- Grouping must remain correct when a status contains more sessions than fit on one page, and the
  creator filter must remain available.
- Child-session trees must remain collapsed by default so fan-out does not flood the sidebar.
- Manual/automatic separation is grouping, not an additional filter.
