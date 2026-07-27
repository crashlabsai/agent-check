"""Minimal agent runtime for the example support team.

Drives delegation: the coordinator dispatches its investigators concurrently
and collects their verdicts before deciding. How many verdicts it waits for is
governed by the coordinator's DelegationPolicy.

This file is deliberately small — it exists so the example has a real
coordination policy for CrashLabs to reason about.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

INVESTIGATORS = ("policy", "fraud", "fulfillment")


@dataclass(frozen=True)
class DelegationPolicy:
    """How the coordinator waits for its investigators before deciding.

    required: investigators whose verdict must be collected before the
        coordinator decides, regardless of any quorum.
    quorum: if set, decide as soon as this many investigators have replied,
        with the verdicts received so far. None means wait for all of them.
    """

    required: frozenset[str] = frozenset()
    quorum: int | None = None


@dataclass(frozen=True)
class Agent:
    id: str
    name: str
    system_prompt: str
    tools: list[str]
    delegates_to: list["Agent"] = field(default_factory=list)
    delegation: DelegationPolicy = DelegationPolicy()


class Runtime:
    async def gather_verdicts(self, coordinator: Agent, case: dict) -> dict:
        """Dispatch the investigators concurrently and collect their verdicts.

        With a quorum set, the coordinator decides as soon as that many
        investigators have replied (required investigators are always awaited
        in full); the rest are cancelled so the slowest check can't gate the
        case.
        """
        policy = coordinator.delegation
        tasks = {
            agent.id: asyncio.create_task(self._run_agent(agent, case))
            for agent in coordinator.delegates_to
            if agent.id in INVESTIGATORS
        }

        if policy.quorum is None:
            results = await asyncio.gather(*tasks.values())
            return dict(zip(tasks, results))

        verdicts: dict = {}
        for agent_id in policy.required:
            if agent_id in tasks:
                verdicts[agent_id] = await tasks.pop(agent_id)
        pending = set(tasks.values())
        while pending and len(verdicts) < policy.quorum:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for agent_id, task in tasks.items():
                if task in done:
                    verdicts[agent_id] = task.result()
        for task in pending:
            task.cancel()
        return verdicts

    async def _run_agent(self, agent: Agent, case: dict):
        """In a real system this calls the model provider."""
        raise NotImplementedError("Wired to your model provider in production.")
