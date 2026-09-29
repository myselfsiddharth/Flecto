# Metrics

Updated weekly. Stars are a lagging vanity metric and are noted, never targeted.

| Metric | How to measure | 3-month target | 2026-09-28 |
|---|---|---|---|
| External repos using the Action | GitHub code search for `flecto-action` and `flecto-pr-risk` in workflow files, excluding the maintainer's repos | 10 | not yet measured |
| Marketplace installs | Marketplace listing stats | trending up | n/a — no listing (Phase 2) |
| Real npm downloads | npm API; weekday vs weekend, ignore release-day spikes | steady baseline > 50/day | 281/30d (~9/day) |
| Issues opened by non-maintainers | GitHub issues filter | 15 | **0** — all 6 open issues are maintainer-authored |
| Interview conversations | count of files in `growth/interviews/` | 10 | 0 |
| Stars | GitHub | do not target | 7 |

## Notes on measuring honestly

- **The npm baseline is the number that matters, not the total.** 281 in 30 days
  includes a release-day spike on 4.0.0 that is mirrors and scanners, not users.
  Record the weekday trough, not the mean. Compare weekday to weekend: real CI
  usage dips on weekends, and mirror traffic does not.
- **"Issues opened by non-maintainers" is currently the most honest single
  number here.** It is 0. It is hard to fake, it cannot be inflated by mirrors,
  and it goes above 0 only when somebody actually ran the thing and cared enough
  to say something. Watch it ahead of downloads.
- **Code search misses private repos**, which is where most Terraform lives. Treat
  the external-repos count as a floor, not a measurement.

## Log

- **2026-09-28** — baseline recorded. See `log.md` for the full table and for
  three corrections to the plan's stated starting numbers.
