# Repository instructions

## Scope and priorities

Build a production-quality board-game rules assistant. Knowledge ingestion, RAG, source attribution and evaluation are the core work. Read docs/README.md and relevant design documents before changing these modules.

## Required contribution workflow

User instruction (2026-11-05): after the initial repository bootstrap, automatically submit code changes as feature-scoped pull requests.

- Use one focused feature/fix branch per coherent change (prefer codex/<short-scope>).
- Start from the current remote default branch, or explicitly document a dependency on an unmerged PR. Do not mix unrelated features.
- Implement, run relevant checks, commit, push the branch, and create a GitHub PR without asking for repeat permission.
- For follow-up work on the same feature, update its existing PR rather than creating a duplicate.
- Do not push feature changes directly to main. Do not force-push or merge PRs unless explicitly authorized.
- PR descriptions explain the problem/result, validation actually performed and material limitations. Keep design docs consistent with implemented changes.
- Return the PR URL and validation status. If authentication or policy blocks publication, report the exact blocker; do not claim a PR exists.
- Do not commit secrets, real .env files, node_modules, build artifacts, private rulebooks or unreviewed model outputs.

## Engineering checks

Use Node.js from .nvmrc. Typical checks: npm run typecheck, npm run worker:check, npm run build. Add focused behavioral tests for implemented business rules; do not treat a scaffold check as a functional test.

Production database synchronization stays disabled. Use TypeORM migrations. Server code enforces identity, quotas, knowledge-version scope and citation validity. Agent tools must not bypass these checks.
