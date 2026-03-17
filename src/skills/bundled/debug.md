---
name: debug
description: Systematic root-cause debugging — invoke when stuck after 2+ failed experiments or facing cascading failures
tools: [memory_ls, memory_read, memory_write, remote_exec, read_file, task_output, show_metrics, compare_runs, web_search, web_fetch]
---
You are entering systematic debugging mode. Something is not working and you need to find the root cause before attempting any more fixes.

**IRON LAW: No fixes without root cause. Symptom fixes are failure.**

## Phase 1: Gather Evidence (DO THIS FIRST)

1. **Read the full error output** — not just the last line. Use task_output to get complete stderr/stdout.
2. **Check what changed** — use remote_exec with `git diff` and `git log --oneline -10` to see recent changes.
3. **Read memory** — check /observations/ and /experiments/ for what was tried and what the results were.
4. **Reproduce** — run the failing experiment again to confirm the failure is consistent, not transient.
5. **Check environment** — did anything change? Disk space, running processes, tool versions?

## Phase 2: Compare Working vs. Broken

1. **Find the last known-good state** — read /best and the experiment that produced it.
2. **List every difference** between the working state and the current broken state.
3. **Bisect if needed** — if many changes were made, test the midpoint to narrow down which change broke things.
4. **Check assumptions** — are you sure the baseline measurements were valid? Re-run the baseline if in doubt.

## Phase 3: Form and Test ONE Hypothesis

1. **State it clearly** — write to /hypotheses/debug-{name}: "I believe X is the root cause because Y"
2. **Design the smallest test** — change ONLY the variable your hypothesis targets
3. **Predict the outcome** — before running, write what you expect to see if the hypothesis is correct
4. **Run and compare** — does the result match your prediction?
5. **If wrong** — the hypothesis is disproven. Return to Phase 1 with this new information. Do NOT try a "variation" of the same hypothesis.

## Phase 4: Fix and Verify

1. Implement the fix targeting the confirmed root cause
2. Run the full experiment to verify the fix works
3. Compare to the previous best — did it actually improve?
4. Check for regressions — run the baseline config to confirm it still works
5. Write findings to /observations/debug-resolution-{name}

## Escalation Rules

- **After 3 failed hypotheses**: Stop. You are likely wrong about something fundamental. Write everything you know to /observations/stuck and use the consult tool for a second opinion.
- **Cascading failures** (each fix reveals a new bug): You are treating symptoms. Go back to the very beginning — what is the FIRST thing that goes wrong?
- **Flaky results** (sometimes works, sometimes doesn't): This is an environment/state issue, not a code issue. Focus on what differs between runs (caches, processes, disk, memory).

## Common Traps

| Trap | What to do instead |
|---|---|
| "Emergency, skip process" | Systematic is always faster than thrashing |
| "I see the problem" | Seeing a symptom ≠ knowing the cause |
| "Fix multiple things at once" | Can't isolate what worked; creates new bugs |
| "One more try" (after 2+ fails) | Step back and question assumptions |
| "Works on my machine" | Compare environments systematically |
