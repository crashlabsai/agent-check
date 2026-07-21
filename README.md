# CrashLabs Agent Check

Behavioral regression testing for AI agents, as a GitHub Action. When a pull request
changes an agent — its prompt, tools, or coordination logic — CrashLabs reruns your agent
team inside simulated copies of your world, injects realistic failures and timing changes,
and verifies what the agents **did** (the tool calls and resulting state), not what they
said. A behavioral regression fails the check and blocks the merge.

## Usage

```yaml
# .github/workflows/crashlabs.yml
name: CrashLabs
on:
  pull_request:
    paths: ["agents/**", "src/**"]

permissions:
  contents: read
  pull-requests: write

jobs:
  behavioral-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: crashlabsai/agent-check@v1
        with:
          config: crashlabs.yml
```

Configure your scenarios and contracts in `crashlabs.yml`. See
[crashlabs.ai/docs](https://crashlabs.ai/docs).

## Why not just unit tests?

Agent regressions are timing-dependent, only visible as side effects, and invisible to
output grading — the agent's final message usually reads perfectly. Normal CI has no world
to check against. CrashLabs rebuilds one.
