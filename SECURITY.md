# Security policy

SCOPE stores prompts, model outputs and evaluation results — data that often contains personal
information and proprietary content. We treat vulnerabilities that could expose that data, or
the credentials SCOPE handles, as the highest priority.

## Supported versions

SCOPE is pre-1.0. Security fixes are released for the latest minor version only.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

## Reporting a vulnerability

**Please do not open a public issue.** Report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on the repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include what you can of:

- the affected component (CLI, SDK, server/API, dashboard, GitHub Action) and version,
- steps to reproduce or a proof of concept,
- the impact you believe it has.

You will get an acknowledgement within 3 business days and a status update at least weekly until
the issue is resolved. We will credit you in the release notes unless you prefer otherwise.

## What we consider in scope

- Exposure of captured prompts, outputs or traces to parties who should not see them
  (for example, a project API key reading another project's data).
- Leaks of provider credentials or SCOPE API keys into logs, traces, reports or the database.
- Authentication or authorization bypass on `scope server`.
- Injection (SQL, script injection in the dashboard) through ingested trace data.
- Redaction failures for the built-in secret patterns documented in
  [ADR 0010](docs/decisions/0010-privacy-defaults.md).

## Known limitations (not vulnerabilities)

- Redaction is pattern-based and cannot catch every secret or piece of personal data. Use
  `privacy.capture_content: false` for regulated data.
- `scope ui` runs without authentication and binds to `127.0.0.1`. Do not expose it on a network;
  use `scope server` with API keys instead.
- `function` steps and custom evaluators execute project code with the CLI's privileges, like a
  test runner. Only run workflows you trust.
