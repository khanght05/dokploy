# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dokploy is a self-hostable PaaS (deploy apps, databases, Docker Compose stacks) built as a pnpm monorepo. The core product is `apps/dokploy`, a Next.js app (pages router) that is both the UI and the tRPC backend, backed by `@dokploy/server` (`packages/server`) which holds almost all business logic (services, db schema, providers, docker/traefik orchestration).

## Workspace layout

- `apps/dokploy` — Next.js app: UI (`components/`, `pages/`, `hooks/`) + backend (`server/`: tRPC routers in `server/api/routers`, queues, wss, migration scripts). Also owns the Drizzle migration files (`drizzle/`) even though schema is defined in `packages/server`.
- `packages/server` (`@dokploy/server`) — shared server package: db schema (`src/db/schema`), business logic (`src/services`), git/docker/traefik provider integrations (`src/utils`), auth (`src/auth`, `better-auth`), email templates. `apps/dokploy` and `apps/api` both depend on this via `workspace:*`.
- `apps/api` (`@dokploy/api`) — standalone Hono API server (port 4000) using `@dokploy/server`.
- `apps/schedules` (`@dokploy/schedules`) — Hono service (port 4001) for scheduled jobs, uses BullMQ.
- `apps/monitoring` — separate Go service for CPU/memory/network/container monitoring (not part of the pnpm workspace).

## Commands

Run from repo root unless noted. Requires Node matching `.nvmrc`/`engines` and pnpm.

```bash
pnpm install
cp apps/dokploy/.env.example apps/dokploy/.env
pnpm run dokploy:setup    # one-time: spins up required services (needs Docker)
pnpm run server:script     # switches @dokploy/server to run from source (scripts/switchToSrc.js)
pnpm run dokploy:dev       # starts the dev server at http://localhost:3000
```

- Build: `pnpm run build` (all packages) or `pnpm run dokploy:build` (just the app).
- Typecheck: `pnpm run typecheck` (runs `tsc --noEmit` in every package).
- Lint/format: `pnpm run format-and-lint` (check only) / `pnpm run format-and-lint:fix` (biome, applies fixes). Biome, not Prettier/ESLint — configure editors accordingly.
- Tests: `pnpm test` (delegates to `apps/dokploy`'s vitest). To run a single test file: `pnpm --filter=dokploy exec vitest run __test__/path/to/file.test.ts --config __test__/vitest.config.ts`. Tests live under `apps/dokploy/__test__/`, config is `apps/dokploy/__test__/vitest.config.ts`.
- Drizzle/db (run inside `apps/dokploy`, config points at `packages/server` schema): `pnpm --filter=dokploy run migration:generate`, `migration:run`, `db:studio`, `db:push`.
- OpenAPI spec regeneration: `pnpm run generate:openapi` (writes `openapi.json` at repo root from the tRPC routers).
- Reset a user's password locally: `pnpm --filter=dokploy run reset-password [email]`.

Per-package dev servers (when working on just one piece): `pnpm --filter=@dokploy/api run dev`, `pnpm --filter=@dokploy/schedules run dev`, `pnpm --filter=server run dev`.

## Architecture notes

- **tRPC is the API surface.** Routers live in `apps/dokploy/server/api/routers/*.ts` and are assembled in `server/api/root.ts`. `server/api/trpc.ts` defines the procedure tiers: `publicProcedure` (no auth), `protectedProcedure` (logged in), `cliProcedure`/`adminProcedure` (owner/admin role), `enterpriseProcedure` (admin/owner + enterprise license present in DB, not re-validated against the license server per-request). Fine-grained permissions on top of roles go through `checkPermission` (`@dokploy/server/services/permission`) using the access-control `statements`. Routers under `routers/proprietary/` gate enterprise-only features (SSO, SCIM, RBAC, audit log, whitelabeling).
- **Business logic belongs in `@dokploy/server`, not in routers.** Routers are thin: validate input with zod, call into `packages/server/src/services/*`, return. Services talk directly to the Drizzle db (`@dokploy/server/db`) and to the docker/git/traefik utils under `src/utils`.
- **DB schema is Drizzle**, defined per-domain in `packages/server/src/db/schema/*.ts` and re-exported from `src/db/schema/index.ts`. Migrations are generated from that schema but stored/run from `apps/dokploy` (`drizzle/`, `migration.ts`) — always regenerate from `apps/dokploy` after changing schema in `packages/server`.
- **Deployments work by shelling out**: services build Docker images / run compose via `execAsync`/`execAsyncRemote` (local vs. remote server over SSH) and generate Traefik config dynamically (`utils/traefik`). Git providers (GitHub, GitLab, Gitea, Bitbucket) each have a `clone*Repository` implementation under `utils/providers`.
- **Cloud vs. self-hosted** behavior is toggled via an `IS_CLOUD` check (`packages/server/src/constants`), referenced in auth, admin, ai, and network services — self-hosted deployments disable cloud-only features (e.g. Stripe billing, some notification/network paths).
- **`@dokploy/server` has a source/dist switch**: `pnpm run server:script` (= `switch:dev`) points its package exports at `src/` for local development; `switch:prod` points at compiled `dist/` for production builds. If cross-package changes in `packages/server` aren't showing up in the app, check which mode is active.
- **Auth** uses `better-auth` (see `packages/server/src/auth`, `apps/dokploy/server/api/trpc.ts` context creation via `validateRequest`), with plugins for API keys, passkeys, SSO, SCIM.

## QC step (fork-specific)

Applications can opt in (`qcEnabled`) to a QC test-plan step backed by the external QC service (QC_Agent_Tool's `app.service_main`, API under `/v1`). Configured by `QC_SERVICE_BASE_URL`, `QC_SERVICE_API_KEY`, `QC_SERVICE_TIMEOUT_SECONDS` (client in `packages/server/src/services/qc-service-client.ts`).
- `deployApplication` (`services/application.ts`) splits a QC-enabled deploy in two shell runs: clone (+patches), then the QC step, then build (+tests). The plan therefore describes exactly the commit read from the fresh clone (`getGitCommitInfo`), and clone auth stays in the provider helpers. Apps without QC (or with an unsupported source) still run as one script.
- `services/qc-step.ts` `runQcStep` creates a service run (`Idempotency-Key` = deployment id), polls it, and caches the plan on the application (`testPlanContent/Version/Status/Error`). It takes a compare-and-set claim (`claimTestPlanGeneration`) so a deploy and a manual regenerate never plan the same app twice; `qcFailurePolicy` `"closed"` makes a failure abort the deploy. Only `github` and `git` sources are supported; others skip.
- `regenerateTestPlan` (router) is non-blocking: it plans the already-deployed commit with `force`, and the UI follows `testPlanStatus`.
- `utils/builders/run-test-command.ts` runs the app's own test command inside the built image after build (`testExecSource` = `command`).
- With `testExecSource` = `generated` the QC step asks the service for plan + generate + triage and stops when the run is `awaiting_exec`; `services/qc-exec.ts` then downloads the sha256-checked bundle and manifest, runs it via `utils/builders/run-generated-tests.ts` in a throw-away container on the build server (source copy, no app env, no capabilities, bounded resources, image per language or `testRunnerImage`), posts the results to the service and records status/summary on the deployment. This happens before the build; `testExecFailurePolicy` decides whether a failure, or a run that couldn't be made, blocks the deploy.
- After the tests run the service triages them: an agent classifies each failure (application bug, wrong test, flaky, environment). Only an application bug (verdict `fail`) can block the deploy; failures judged otherwise (`warn`) are recorded as failed on the deployment but never block. The deployments list shows the classification and a Report button (`deployment.qcReport`, shown in a sandboxed iframe). An optional webhook (`pages/api/qc/webhook.ts`, HMAC-verified in `services/qc-webhook.ts`) wakes the poller early; polling stays authoritative.
- Operator documentation (setup, policies, troubleshooting): `docs/qc-step.md`.
- UI lives in `components/dashboard/application/qc/` and `advanced/qc/`. `qcProjectId` is a leftover column from the old per-project API and is unused.

## Code style
- Don't write comments that restate what the code already says.
- Comment only the "why" when something isn't obvious: workarounds,
  counterintuitive decisions, constraints from an external API.
- No section-divider comments like `// --- Helpers ---`.
- Don't leave comments describing the change you just made.
- Formatting/linting is enforced by Biome (`biome.json`) — don't hand-format against it or introduce Prettier/ESLint config.
