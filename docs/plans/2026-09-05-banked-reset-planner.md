# Banked reset planning

## Objective

Maximize estimated work served before the last known reset expiry plus one quota
cycle, using recent measured token demand. Benefits are additional supported tokens
relative to waiting for natural resets. They are not cash savings or task quality.

## Inputs and scope

- Use sanitized available-credit statuses and individual expiry timestamps.
- Reuse the existing model-aware, cross-segment quota fit and recent weighted rate.
- Preserve independent provider/window histories. Simulate the provider's full
  weekly pool, not a user-selected model-specific window.
- Only schedule known full resets with known expiries and matching available counts.
- Stale account snapshots (six hours), weak fits or insufficient intervals produce
  conditional advice, never an invented token capacity or exact schedule.
- The plan uses the existing weekly-or-longer view. Short-window throttling and
  other products sharing the account can reduce actual served work.

## Search

Forward beam search considers waiting or restoring the pool at each half-hour
boundary, also including natural resets and each credit's one-hour expiry margin.
Credits are interchangeable full resets and consumed earliest-expiry-first. Same-day
multiple resets are supported. State includes remaining percentage, next natural
reset time, credit position, served demand and discarded balance. Percentages are
continuous; rounding only bounds retained candidate states (32 per credit position).

Natural resets refill rather than accumulate capacity. Restarting resets change the
next natural boundary. The no-reset path is retained explicitly; equal-work results
prefer fewer resets and then less discarded capacity. This is bounded approximate
optimization, not a claim of continuous global optimality. It models uniformly
distributed hourly demand and does not infer working/sleeping hours from day totals.

The bounded horizon is 60 days; at most 24 known credits enter each calculation.
Deferred or unrecognized credits are reported. After expiry, already-restored quota
remains usable until the simulated period reset, hence the one-cycle tail.

## Provider semantics

Codex: a full reset refreshes the 5-hour and weekly windows and changes the weekly
reset date. Model immediate resumed work as a new weekly cycle. Offer-specific scope
and the actual reset date must still be read again after use.
Source: https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work

Grok: current read-only RPC returns inventory and expiry but does not establish the
next-period effect. Compare fixed-calendar and restarted-cycle scenarios; the UI
must label these as assumptions, not confirmed schedules.

## Output and refresh

An independent planner view shows next action, no-reset/with-reset work estimates,
unused credits, lost balance, per-credit schedule and 0.7x/1x/1.3x demand scenarios.
These are sensitivity scenarios, not confidence intervals. Planning is read-only.
When the normal pace cannot use the stock, search between 1x and 8x demand for a
feasible reference workload that uses each included reset with at most 5% discarded
balance. Enforce both constraints during the search: paths that miss a credit's
deadline or discard more than 5% are infeasible. Do not substitute a higher-serving
plan that only uses part of the inventory. Use six binary refinements after
bracketing; this is not a global minimum
claim. Compare against the no-reset baseline at that same increased workload. Only
show this as an optional scenario when the user has additional useful work.
All searches execute in a Web Worker so a larger inventory does not block navigation.
Page entry reads the latest usage/quota and credit payloads; the existing all-source
export updates inputs, then recomputes. No reset is redeemed by this feature.

## Verification

Tests cover expiry filtering, count mismatch, missing/weak/stale calibration, empty
inventory, natural refill vs extra capacity, restarted cycles, low demand, multiple
same-day resets, expiry margins and baseline dominance. UI checks cover desktop,
mobile, pending/error states, provider switching and global-refresh recalculation.
Clustered-expiry regression cases also verify full-stock feasibility under small
changes in sampling time and pace, plus explicit infeasibility at insufficient pace.
