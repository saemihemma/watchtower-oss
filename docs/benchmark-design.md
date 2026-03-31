# Watchtower Benchmark Design

## The Question

**Does loading a skill library make an LLM measurably better at real engineering work?**

Not "is the documentation well-written" — but does having structured skills in context produce better architecture decisions, tighter scope control, stronger evidence chains, and more actionable handoffs?

## Why Existing Approaches Fail

Most skill library evaluation is either:

1. **Documentation review** — "Are the skill files well-organized?" This tests writing quality, not effectiveness. A beautifully documented skill library that doesn't change LLM behavior scores 100%.

2. **Vibes** — "It feels like the LLM is better with skills." No measurement, no comparison, no reproducibility.

Neither answers the real question. Watchtower answers it with a controlled A/B test.

## Research Basis

This benchmark design is informed by:

- **SWE-bench** (Princeton, 2023): Functional task outcomes beat subjective ratings. The gold standard is verifiable: does the code patch pass tests?
- **LLM-as-Judge research** (multiple papers, 2024-2025): Known biases include self-preference (LLMs rate their own style higher), verbosity bias (longer = better), and position bias. Mitigated by detailed rubrics, A/B framing, and pairwise comparison.
- **Chatbot Arena** (LMSYS, 2023): Pairwise comparison ("which is better?") is more robust than absolute scoring ("rate 1-10").
- **Devil's Advocate research** (ACL 2024, ACM IUI 2024): Structured adversarial review produces measurable improvement in decision quality and consistency.
- **GPQA** (Rein et al., 2023): Graduate-level "Google-proof" questions where deep reasoning — not surface knowledge — determines success.
- **BIG-Bench BBH** (Google, 2022): Formal reasoning tasks where structured methodology catches logical errors.

## Benchmark Architecture

### A/B Comparison Design

```
Side A: LLM + skill library loaded as context
Side B: LLM + no skills (empty baseline)
─────────────────────────────────────────────
Same LLM. Same task. Same rubric. Same judge.
Only variable: whether skills are present.
```

The LLM is both performer and judge (single-call architecture). This introduces self-preference bias in absolute scores — but the A/B DELTA controls for it, since both sides use the same judge. The delta reflects the difference skills make.

### Three Measurement Profiles

| Profile | What it measures | Scoring method | Signal type |
|---------|-----------------|----------------|-------------|
| `default` | Process discipline (routing, scope, evidence, handoff) | LLM rubric (0-4) | Subjective but high-signal for what skills uniquely add |
| `grounded` | Accuracy on hard, verifiable problems | Correct answer match | Objective ground truth |
| `library-quality` | Documentation organization | LLM rubric (0-4) | Surface quality of skill files |

**Why three?** A skill library that scores high on `default` + `grounded` but low on `library-quality` is effective but poorly documented. One that scores high on `library-quality` but low on `default` + `grounded` is well-documented but doesn't help. The combination tells the full story.

## Profile 1: Process Discipline (Default)

**Design principle**: Skills don't add engineering KNOWLEDGE — Opus already knows how to design caches and plan migrations. Skills add PROCESS DISCIPLINE: routing, scope control, evidence gates, adversarial review, structured handoff. These tasks test what skills uniquely provide.

**Each task is intentionally messy, multi-domain, or ambiguous** so that a bare LLM produces reasonable but unstructured output, while a skilled LLM produces structured, scoped, evidence-backed output with clear ownership and handoffs.

### Categories and Weights

| Category | Weight | What it tests |
|----------|--------|---------------|
| Structured Reasoning | 35% | Conflict resolution, investigation methodology, traceable decisions |
| Scope Discipline | 35% | Bounding what to do and what NOT to do, resisting scope creep |
| Handoff Quality | 30% | Durable artifacts another person can act on without follow-up |

### Task 1: Cross-Domain Conflict Resolution

**Category**: Structured Reasoning

**Prompt**: You have three conflicting specialist recommendations for a live-service game update. The backend engineer says to rebuild the inventory service for horizontal scaling (3 weeks). The game designer says to ship a new crafting system next sprint to hit a content deadline. The security engineer says the current auth token system has a known vulnerability and must be patched before any new features ship. Using any relevant skills from the loaded library, produce a structured resolution: who owns what decision, what ships in what order, what evidence supports each priority, and what gets deferred with stated consequences.

**Rubric** (0-4):
- 0: Ignores conflicts or picks one side arbitrarily
- 1: Acknowledges conflict but no resolution framework
- 2: Attempts to sequence but missing ownership or evidence
- 3: Clear priority ordering with stated ownership, evidence for sequencing, and explicit deferrals
- 4: Rigorous resolution with risk-ranked sequencing, ownership matrix, evidence chain for each decision, explicit assumptions, and a bounded scope for each work item

**Why skills matter**: A bare LLM gives generic "balance all concerns" advice. Skills with routing protocols, conflict resolution rules, and evidence requirements produce structured, traceable decisions.

### Task 2: Ambiguous Production Issue

**Category**: Structured Reasoning

**Prompt**: A production system intermittently returns incorrect pricing for 2-3% of orders. No recent deployments. The pricing service, inventory service, and cache layer all show normal metrics. Customer reports started 4 days ago but the team only noticed today. Using any relevant skills from the loaded library, produce a structured investigation plan: hypotheses ranked by likelihood, data needed to confirm or eliminate each, who should investigate what, and how to communicate status to stakeholders.

**Rubric** (0-4):
- 0: Jumps to a fix without investigation
- 1: Lists possible causes but no methodology
- 2: Some structured hypotheses but missing verification steps or ownership
- 3: Ranked hypotheses with specific data requirements, investigation ownership, and stakeholder communication plan
- 4: Comprehensive investigation package: hypotheses ranked with stated confidence, specific queries/logs to check for each, clear ownership per hypothesis, escalation triggers, and a handoff artifact if the first investigator cannot resolve

**Why skills matter**: Tests investigation discipline, evidence requirements, and structured handoff — not debugging knowledge.

### Task 3: Intentionally Overbroad Request

**Category**: Scope Discipline

**Prompt**: A stakeholder asks: "Make our platform more scalable, more secure, and easier for new developers to onboard. We have 6 weeks and 4 engineers." Using any relevant skills from the loaded library, respond to this request. Decide what is in scope vs out of scope, what to investigate first vs defer, and produce a scoped plan that can actually ship in the constraints.

**Rubric** (0-4):
- 0: Tries to do everything or gives vague advice
- 1: Acknowledges the scope problem but does not resolve it
- 2: Narrows somewhat but still overcommits or leaves scope ambiguous
- 3: Explicitly bounds scope, names what is deferred and why, produces a plan that fits the constraints
- 4: Sharp scope control: names the one or two highest-leverage areas, explicitly rejects or defers the rest with stated trade-offs, produces a concrete plan with acceptance criteria, and flags assumptions that could change the scope

**Why skills matter**: The biggest value of skills is SCOPE DISCIPLINE. A bare LLM tries to address everything. A skilled LLM narrows to what matters.

### Task 4: Scope Creep Mid-Project

**Category**: Scope Discipline

**Prompt**: You are midway through a 3-week sprint to add multi-currency support to a payment system. The product manager now asks to also add subscription billing "since we're already changing the payment code." The team has 1.5 weeks left. Using any relevant skills from the loaded library, respond with a structured decision: accept, defer, or negotiate, with evidence for your recommendation and explicit impact on the original scope.

**Rubric** (0-4):
- 0: Accepts without analysis
- 1: Pushes back but without evidence
- 2: Analyzes impact but recommendation is vague
- 3: Clear recommendation with impact analysis, timeline evidence, and explicit scope boundary
- 4: Rigorous scope defense: quantified impact on current sprint, risk assessment of combining changes, explicit recommendation with reversibility analysis, and a concrete alternative timeline for the deferred work

**Why skills matter**: Tests whether skills provide scope defense patterns and evidence-based pushback.

### Task 5: Specialist-to-Specialist Handoff

**Category**: Handoff Quality

**Prompt**: You have completed a security review of a new API gateway. You found 3 issues: (1) JWT tokens don't expire for 30 days, (2) rate limiting is per-IP only (no user-level), (3) admin endpoints are accessible without role checks. The backend team will implement the fixes. Using any relevant skills from the loaded library, produce the handoff artifact: what exactly needs to change, what the acceptance criteria are for each fix, what can be done in parallel, and what the backend team should NOT change.

**Rubric** (0-4):
- 0: Vague summary or just a list of issues
- 1: Issues described but no acceptance criteria or scope
- 2: Some structure but missing priority, parallelism, or scope boundaries
- 3: Clear handoff with per-issue acceptance criteria, priority ranking, and explicit scope boundaries
- 4: Durable handoff artifact: each issue has severity, acceptance criteria, suggested implementation approach, what NOT to touch, parallelism guidance, and a verification plan the backend team can execute independently

**Why skills matter**: The skills should produce a handoff that another team can act on without follow-up questions.

### Task 6: Investigation-to-Decision Handoff

**Category**: Handoff Quality

**Prompt**: After investigating a performance regression, you've found three contributing factors: (1) a new ORM query generating N+1 selects (accounts for ~60% of latency), (2) cache hit rate dropped from 95% to 70% after a config change, (3) connection pool is undersized for current load. Using any relevant skills from the loaded library, package your findings into a handoff for the engineering lead to make a prioritized fix decision. Include your confidence level for each finding and what you could NOT verify.

**Rubric** (0-4):
- 0: Raw notes or stream-of-consciousness
- 1: Findings listed but no confidence levels or gaps
- 2: Some structure but missing what was not verified
- 3: Structured findings with confidence levels, verification gaps, and clear recommendation
- 4: Decision-ready package: each finding has evidence, confidence level, what was verified and what was not, impact estimate, effort estimate, and a recommended fix order — actionable without the original investigator present

**Why skills matter**: A bare LLM states findings as facts. A skilled LLM states confidence levels and gaps.

### Task 7: Cross-Team Synthesis

**Category**: Handoff Quality

**Prompt**: Three teams have completed independent reviews of a proposed microservices migration: The platform team says it's feasible but needs 6 months. The product team says it will block 2 planned features. The security team says the current monolith has 3 critical vulnerabilities that would be easier to fix post-migration. Using any relevant skills from the loaded library, synthesize these into a single recommendation: go, no-go, or conditional-go, with the evidence chain and what decision the leadership team actually needs to make.

**Rubric** (0-4):
- 0: Picks one team's view without synthesis
- 1: Summarizes all views but no recommendation
- 2: Recommendation present but not grounded in evidence from all three teams
- 3: Clear recommendation with evidence chain connecting all three perspectives and explicit trade-offs
- 4: Decision-ready synthesis: recommendation with evidence chain, dissenting concerns preserved (not collapsed), explicit assumptions, reversibility assessment, and a clear articulation of what leadership is actually deciding — not the implementation details

**Why skills matter**: Tests cross-functional synthesis. Skills with routing, conflict resolution, and evidence standards should produce dramatically better output.

### Task 8: Ambiguous Routing

**Category**: Handoff Quality

**Prompt**: A developer reports: "The checkout flow is broken for users in Japan. Sometimes the total is wrong, sometimes the page crashes. I think it's a currency conversion bug but it might be a frontend rendering issue or a timezone thing." Using any relevant skills from the loaded library, route this to the right people, scope the initial investigation, define what "fixed" means, and produce the first communication to the team.

**Rubric** (0-4):
- 0: Starts fixing without routing or scoping
- 1: Assigns to someone but no investigation scope or definition of done
- 2: Some routing and scope but missing communication or acceptance criteria
- 3: Clear routing with investigation scope, definition of done, and team communication
- 4: Full routing package: assigns ownership with rationale, scopes investigation to avoid premature fixing, defines acceptance criteria, produces stakeholder communication, and sets a check-in point to prevent drift

**Why skills matter**: Tests ROUTING — the core value proposition of skill libraries. A bare LLM dives into debugging. A skilled LLM routes, scopes, defines done, and communicates.

## Profile 2: Grounded Verification

**Design principle**: Eliminate LLM-as-Judge subjectivity by using problems with known correct answers. The LLM works the problem WITH skills loaded (side A) and WITHOUT (side B). The delta in accuracy measures whether skills improve reasoning.

### Sources

| Source | What | Public | Size |
|--------|------|--------|------|
| GPQA Diamond | Graduate-level science (physics, chemistry, biology) | Yes, HuggingFace | 448 questions |
| BIG-Bench BBH | Formal reasoning (logic, causality, probability) | Yes, GitHub | 6.5K tasks across 23 categories |
| SWE-bench Verified | Real software bugs with test suites | Yes, HuggingFace | 500 issue-PR pairs |
| K8s failure stories | Real production incidents | Yes, k8s.af + GitHub | 50+ post-mortems |

### Task Selection Criteria

Problems are selected where:
1. A bare LLM gets ~50-70% right (hard enough to differentiate, not impossible)
2. Structured reasoning / adversarial review has a plausible path to improvement
3. The correct answer is unambiguous
4. The problem fits a single LLM call (no multi-turn interaction needed)

### Categories and Weights

| Category | Weight | Tasks |
|----------|--------|-------|
| Reasoning Accuracy | 40% | GPQA + BBH (physics, chemistry, logic, causality, probability) |
| Engineering Accuracy | 60% | SWE-bench + post-mortems + code review |

### Tasks

1. `grounded_physics_001` — GPQA Diamond physics question requiring multi-step reasoning
2. `grounded_chemistry_001` — GPQA Diamond chemistry question
3. `grounded_logic_001` — BBH formal fallacy problem
4. `grounded_causal_001` — BBH causal judgment problem
5. `grounded_probability_001` — BBH probability puzzle
6. `grounded_debug_001` — SWE-bench issue: identify root cause
7. `grounded_postmortem_001` — K8s incident: identify what went wrong
8. `grounded_review_001` — Code snippet with subtle bug: catch it

## Profile 3: Library Quality (Documentation Review)

The original 8 tasks, moved to a separate profile. Tests whether skill files are well-organized, clearly scoped, and well-written.

Useful as a secondary signal: a library can score high on process discipline and grounded accuracy while having mediocre documentation. Or vice versa.

| Category | Weight | Tasks |
|----------|--------|-------|
| Routing Accuracy | 30% | Usage guidance, discoverability |
| Boundary Clarity | 25% | Scope framing, ownership separation |
| Review Quality | 25% | Evidence standards, concrete steps |
| Handoff Quality | 20% | Next actions, context preservation |

## Scoring Methodology

### Per-Trial
Each task runs N trials per side (default 3, max 5). Each trial produces a normalized score (0-1 for rubric tasks, binary for deterministic tasks).

### Per-Task
Task score = median of valid trial scores. Requires minimum 2 valid trials.

### Per-Category
Category score = mean of task scores in that category, scaled to 0-100.

### Overall
Overall score = weighted mean across categories using profile-specific weights.

### Statistical Analysis
- **Bayesian posterior**: Prior mean 0.5, sigma 0.15. Likelihood sigma 0.1. Produces posterior mean, sigma, and 95% CI for each side.
- **Bootstrap CIs**: 10,000 resamples with seed 42. Produces 95% confidence interval on the delta.
- **ROPE verdict**: Region of Practical Equivalence at ±5 points. Verdict: left_wins, right_wins, equivalent, or undecided.
- **Coefficient of Variation**: Per-category stability indicator. CV < 0.1 = very stable, < 0.2 = stable, ≥ 0.2 = unstable.

### Winner Determination
- Delta ≥ 5 points AND no critical regression → winner declared
- Critical regression (task score drop ≥ 0.15 on critical task) → blocks winner even if overall score is better
- Otherwise → too_close_to_call

## Known Limitations

1. **LLM-as-Judge bias**: The same LLM performs the task and scores the output. Absolute scores are inflated. But the A/B delta controls for this — both sides use the same judge.

2. **Self-preference bias**: LLMs assign higher scores to text with lower perplexity (their own style). Controlled by same-model comparison. For cross-model validation, run with multiple executors.

3. **Finite task set**: 8 tasks per profile. Gameable in theory (optimize for these specific scenarios). Mitigated by task diversity and the grounded profile's objective scoring.

4. **Process tasks are subjective**: The 0-4 rubric requires judgment. The grounded profile compensates with verifiable answers.

5. **Grounded tasks test reasoning, not process**: GPQA and BBH test whether the LLM gets the right answer, not whether the output is well-structured. The process profile compensates.

6. **Single-call architecture**: The LLM sees skills + prompt + rubric in one call. It cannot iteratively consult skills during multi-step work. This understates the value of skills designed for interactive use.

## Open Questions for Reviewers

1. **Are the process tasks genuinely complex enough to differentiate a skilled LLM from a bare one?** Specifically: will a bare Opus 4.6 score 2/4 on these, or 3/4? If 3/4, the ceiling for improvement is too low.

2. **Are the grounded task selections appropriately difficult?** Problems that are too easy (>90% bare accuracy) or too hard (<20%) don't show differentiation.

3. **Should category weights be different?** Currently: structured_reasoning 35%, scope_discipline 35%, handoff_quality 30%. Is scope discipline over- or under-weighted?

4. **What additional task types would improve coverage?** What engineering scenarios are we missing?

5. **Is the A/B design sufficient to control for LLM-as-Judge bias?** Or should we add a separate evaluation pass where a DIFFERENT model scores both outputs?

6. **Should we add pairwise comparison?** Instead of scoring each side independently (0-4), have the judge see BOTH outputs and pick the better one. Research suggests this is more robust.

7. **How do we handle the "skills might hurt" case?** If a skill library's routing overhead makes the LLM slower or more confused on simple tasks, the benchmark should detect this. Do we need simple-task tasks alongside complex ones?
