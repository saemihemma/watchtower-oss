# Good Skill: Request Router

A well-designed skill demonstrating clear routing, explicit boundaries, strong evidence, and proper handoffs.

## What It Is

A request router that intelligently directs incoming tasks to the most appropriate specialist, broker, or team. Routes based on:

1. **Skill domain** — technical, business, creative, strategic
2. **Urgency level** — immediate, urgent, standard, deferrable
3. **Complexity grade** — simple, moderate, complex, novel
4. **Audience type** — individual contributor, manager, executive, external

Produces routing recommendations with **confidence scores** and **alternative paths**.

## What It Is NOT

- Not a task executor or doer
- Not a specialist — it routes TO specialists
- Not a substitute for human judgment on edge cases
- Not a replacement for escalation protocols in your organization

## Use When

- You receive a request and need to find the right person fast
- You have a team with diverse specialties
- You want **consistent routing logic** across the organization
- You need **audit trails** of who got routed where and why
- You want to prevent **specialist bottlenecks** by load balancing

## Do NOT Use When

- You already know exactly who should handle it (just go directly)
- The request is truly one-of-a-kind with no routing precedent
- Your team is so small everyone does everything anyway
- Your organization lacks the needed specialist roles

## Routing Boundaries

The router respects these hard boundaries:

1. **Only routes to existing roles** — will not invent new specialist roles
2. **Respects skill prerequisites** — won't route to someone not yet trained
3. **Honors availability** — checks before routing to someone on leave
4. **Escalates at capacity** — doesn't overload any single person
5. **Preserves context** — includes all relevant background in handoff

## Evidence of Effectiveness

Based on real deployment across 3 organizations:

- **80% first-contact resolution** — routed request goes to right person first time
- **22% time savings** — vs. manual request review by manager
- **91% satisfaction** — requesters felt routed appropriately
- **Reduced bottlenecks** — 40% fewer requests pile-up on subject matter experts

These metrics were tracked across 1,200+ routed requests over 6 months.

## Devil's Advocate

**Question:** What if the router is wrong?

**Counter:** The skill is designed for 80% accuracy, not 100%. On the 20% of edge cases, the handoff message includes:
- Why this routing was chosen
- What signals suggested it
- Alternative routing options
- Escalation path if the current recipient isn't the right fit

The recipient can always say "this isn't mine" and re-route. The goal is to reduce routing overhead, not eliminate human judgment.

## Acceptance Criteria

You should be able to:

1. Ask the router a vague request: "I need help with a network issue"
2. Get back a recommendation: "Send to Alex (Network Lead) because your request mentions 'network' + priority is 'urgent' + Alex has capacity"
3. See confidence: "73% confident this is the right call"
4. See alternatives: "If Alex is unavailable, try Jordan (Infrastructure) or escalate to Head of Ops"
5. Know what happens next: "Click here to route + send handoff"

## Open Questions

- Should the router consider **learning from outcomes**? (e.g., "This was routed wrong — adjust future routing")
- How to handle **cross-functional requests** that span multiple specialties?
- What if a **specialist role doesn't exist yet** — should routing propose creating it?

## Next Action

1. Copy the router logic into your communication system
2. Add your organization's roles and skills to the routing table
3. Define confidence thresholds (e.g., require 70%+ to auto-route)
4. Track outcomes for 30 days to calibrate
5. Iterate on routing rules based on what you learn
