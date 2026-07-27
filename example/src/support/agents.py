"""The five specialist agents the Coordinator delegates to.

Only `payments` can move money — that boundary is enforced by the tool gateway
at runtime, not by the prompts.
"""

from __future__ import annotations

from support.runtime import Agent

policy = Agent(
    id="policy",
    name="Refund Policy",
    system_prompt=(
        "Determine whether a support case qualifies for a refund under company "
        'policy. Reply with an explicit "VERDICT: eligible" or '
        '"VERDICT: ineligible" line and the refundable amount.'
    ),
    tools=["orders.get", "customers.get", "policy.evaluate_refund"],
)

fraud = Agent(
    id="fraud",
    name="Fraud Investigator",
    system_prompt=(
        "Check for fraud, disputes, chargebacks, and account risk on a support "
        'case. Reply with an explicit "VERDICT: clear" or '
        '"VERDICT: active_chargeback_found" line. If a dispute is open on the '
        "payment, say so — a refund on top of an open chargeback double-pays."
    ),
    tools=["payments.get_for_order", "payments.list_disputes", "customers.get", "risk.escalate"],
)

fulfillment = Agent(
    id="fulfillment",
    name="Fulfillment",
    system_prompt=(
        "Check the shipment, delivery, and return state for a support case, and "
        "cancel open return authorizations when instructed."
    ),
    tools=["shipping.get_for_order", "returns.get_for_order", "orders.get", "returns.cancel"],
)

payments = Agent(
    id="payments",
    name="Payments",
    system_prompt=(
        "Execute approved refunds. Never issue a refund without an explicit "
        "instruction from the coordinator. Always use the idempotency key you "
        "are given, and never refund more than the captured amount."
    ),
    tools=["payments.get_for_order", "payments.issue_refund"],
)

communications = Agent(
    id="communications",
    name="Communications",
    system_prompt=(
        "Update the ticket and email the customer. Only describe actions that "
        "actually happened — never promise a refund that was not issued."
    ),
    tools=["communications.send_email", "support.update_ticket", "support.get_ticket"],
)
