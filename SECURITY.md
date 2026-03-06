# Security Policy

## Reporting a Vulnerability

If you find a security issue in Cortex, please report it privately. Do not open a public issue.

**Email:** security@alaarab.com

Include:

- A description of the vulnerability
- Steps to reproduce it
- The impact (what an attacker could do)
- Your suggested fix, if you have one

## What Counts as a Security Issue

- Path traversal (reading or writing files outside the cortex directory)
- Arbitrary code execution through MCP tool inputs
- Information disclosure (leaking data from other projects or profiles)
- Injection attacks through FTS5 queries or CLI arguments
- Bypass of memory access controls or role-based permissions

## What Does Not Count

- Bugs that require local filesystem access (cortex is a local-first tool)
- Issues that require the user to run malicious commands themselves
- Feature requests or general bugs (use the issue tracker for these)

## Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix or mitigation:** depends on severity, but we aim for 30 days for critical issues

## Supported Versions

Security fixes are applied to the latest release only. There is no long-term support for older versions.

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will credit the reporter in the changelog unless they prefer to stay anonymous.
