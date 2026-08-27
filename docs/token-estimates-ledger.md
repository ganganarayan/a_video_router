# Token estimate vs. actual — learning ledger

Purpose: before starting a task/phase, record a tentative token estimate; after finishing,
record the actual (best estimate — exact counts aren't exposed to the model) and the variance.
Use accumulated variances to calibrate future estimates.

**Method / rules of thumb (updated as we learn):**
- Estimate the *incremental work* tokens (reading + reasoning + writing + verifying), NOT the
  one-time session context overhead (system prompt, memory, tool schemas load once).
- In THIS codebase, adding a static content page = view + 1-line `pages` map entry + 1-line nav
  tab + EJS smoke test. This is CHEAP — the page pattern is boilerplate. Calibration so far:
  such pages ran well under a naive first estimate.
- A "+deploy" phase (staging deploy + live verify via DoH/curl --resolve) adds a real chunk on
  top of the build (network round-trips, log reads, re-verify).
- Backend phases (migration + API + tests + email) cost noticeably more than pure-view phases.

**Metric:** "Actual" = the objective per-turn drop in the harness `<total_tokens>` budget
counter (it resets each turn, so the delta ≈ that turn's real token spend, INCLUDING the
one-time session context load). This is the anchor to calibrate against — not my gut feel.

| Date | Task / phase | Tentative | Actual (counter Δ) | Variance | Lesson |
|------|--------------|-----------|--------------------|----------|--------|
| 2026-08-27 | Help/KB **Phase 1** (build + local smoke, no deploy) | 90k | ~85k (incl. 1st-turn context load) | ≈ on target, but see note | Build-only cost was well under 85k; the turn also paid the one-time context load. Static content page here is boilerplate — the view copy is the only real cost. |
| 2026-08-27 | **Railway memory audit** (read pipeline+providers+web, fix dbadmin export streaming) | 120–160k | ~45k | **−65%** (badly over-estimated) | **Key calibration: my gut estimates run ~2–3× the objective counter.** Reading ~11 files + 1 fix + verify = ~45k, not 120k+. Going forward, after gut-estimating, DIVIDE BY ~2.5 for the counter metric. Audits of already-clean code are cheap (reading dominates, few writes). |

**Standing estimates for the remaining Help/KB phases (revise as actuals land):**
- Phase 1 + staging deploy & verify: +40k → ~95k total (deploy portion still unproven — update when done).
- Phase 2 (contextual "?" + public KB + admin-editable): ~70k build (+30k deploy). Lower confidence.
- Phase 3 (support form: migration + API + email + tests): ~120k build (+40k deploy). Backend-heavy.
