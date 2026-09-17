# Subagent Cooldown Tracker

Tracks failure timestamps per worker to avoid retrying failed subagents prematurely.

## Active cooldowns

| Worker | Last failure (UTC) | Cooldown until |
|--------|--------------------|----------------|
| _none_ | — | — |

## Policy

- When a worker fails twice or times out, it enters a 24h cooldown.
- Skip a worker on cooldown; retry after 24h.
- Last updated: 2026-09-17
