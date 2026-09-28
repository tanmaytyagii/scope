# 0011 — Apache-2.0 license

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

SCOPE is developer infrastructure that companies will run internally and extend.

## Decision

License the entire repository under **Apache-2.0**.

## Consequences

- Includes an explicit patent grant, which legal teams at adopting companies look for in
  infrastructure dependencies (as with OpenTelemetry and Kubernetes).
- Contributions are accepted under the same license (inbound = outbound); no CLA.

## Alternatives considered

- **MIT.** Equally permissive and simpler, without the patent grant.
- **Source-available licenses (ELv2, BSL).** Incompatible with the open-source-first principle.
