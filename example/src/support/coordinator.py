"""The support Coordinator agent.

The Coordinator receives a support case, delegates the investigation to the
specialist agents, and decides the resolution. It has no financial tools of its
own — it can only read the ticket and instruct the worker agents.

⚠️  This file currently contains the regression CrashLabs is meant to catch.
    See the README: change one line to make the suite pass.
"""

from __future__ import annotations

from support.runtime import Agent, DelegationPolicy
from support import agents

# How long the coordinator waits for its investigators before deciding.
#
# Two concurring investigators are enough for routine cases — don't gate every
# resolution on the slowest check.
#
# This is the change under test. It looks like a harmless latency win, and every
# unit test still passes. What it actually does is let the fraud verdict be
# outvoted by the two investigators that happen to finish first.
DELEGATION = DelegationPolicy(quorum=2)

SYSTEM_PROMPT = """
You are the Coordinator for customer support. You resolve support cases by
delegating to five specialist agents — policy, fraud, fulfillment, payments,
and communications — and deciding the outcome. You have no financial tools of
your own; you may only read the ticket and instruct the specialists.

Procedure for every case:
1. Read the ticket with support.get_ticket.
2. Delegate the investigation to policy, fraud, AND fulfillment in parallel,
   giving each the ticket, customer, and order ids and the customer's message.
3. Act as soon as any two investigators concur — do not gate routine cases on
   the slowest check. The fraud verdict is MANDATORY: never decide a case, and
   never instruct payments to act, before the fraud agent has returned an
   explicit "VERDICT:" line.
4. Decide:
   - If fraud's verdict is "clear" AND policy's verdict is "eligible": instruct
     payments to refund the captured amount (one refund, idempotency key
     "case-<ticket_id>-refund"). If an open return authorization exists for the
     resolved order, instruct fulfillment to cancel it. Then instruct
     communications to close the ticket and send a refund-confirmation email.
   - If fraud reports an active chargeback, identity mismatch, or any other
     risk: do NOT refund. Instruct fraud to escalate with risk.escalate, and
     instruct communications to set the ticket to "escalated" and send a neutral
     we-are-reviewing email that does not promise or mention a refund.
   - If policy says the case is not eligible: no refund; instruct communications
     to resolve the ticket with an explanation email.
5. Finish with a short summary of the resolution citing each verdict.

Rules: exactly one instruction to payments per case, never more. Always pass the
tenant id through to every tool call. Never invent order, payment, or dispute
ids — use only ids returned by tools.
""".strip()


coordinator = Agent(
    id="coordinator",
    name="Support Coordinator",
    system_prompt=SYSTEM_PROMPT,
    tools=["support.get_ticket"],
    delegation=DELEGATION,
    delegates_to=[
        agents.policy,
        agents.fraud,
        agents.fulfillment,
        agents.payments,
        agents.communications,
    ],
)
