---
id: 05-provider-stall
title: Provider failure / stall surfacing and bounding
type: rebuild
priority: medium
placement: upstream-code
depends_on: []
origin: upstream #25; fork commits 647303c (A), bfac2fc + 4e9376c (B, reference only)
---

## Outcome

Users can distinguish provider retries from active work, and persistent provider rejection ends in a
visible failure.

## Observable behavior

While the provider retries a rejected request, the session timeline shows the attempt count and the
next attempt time. The fourth consecutive rejection stops the request and reports the failure
instead of retrying indefinitely.

## Durable constraints

- Four consecutive provider rejections end the request.
- Silence or lack of output alone must not end a request.
- A slow operation with no provider rejection must not be terminated as stalled.
- Every terminal retry failure must remain visible to the user.
