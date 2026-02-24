# Copilot Instructions for `whatsapp-service`

## Big picture (read this first)
- Entry point is `src/main.ts`: builds WhatsApp clients, mounts all controllers, serves `public/`, and starts background workers (`gupshupWebhookQueueService`, `wabaWebhookQueueService`, `messageQueueService`, `internalMessageQueueService`).
- App shape is **Controller → Service → Prisma**. Controllers are thin routers in `src/controllers`; business rules live in `src/services`; persistence uses `prismaService` (`src/services/prisma.service.ts`) and models in `prisma/schema.prisma`.
- Multi-provider WhatsApp support is centralized in `src/services/whatsapp.service.ts` via `WhatsappClient` implementations (`WWEBJS`, `WABA`, `GUPSHUP`, `REMOTE`). Preserve this abstraction when adding provider-specific behavior.
- Chat routing/assignment is flow-driven: message-flow engine in `src/message-flow/*`, with step registration in `src/message-flow/register-steps.ts` and runtime factory in `message-flow.factory.ts`.
- Incoming message processing is queue-first for reliability: `message-queue.service.ts` and `internal-message-queue.service.ts` persist work, lock per contact/chat, and retry.

## Critical invariants
- Do not bypass persistent queues for inbound processing. Keep `enqueue → worker → processHandler` behavior intact to avoid message loss/duplicate chat creation.
- Keep per-contact/per-chat serialization semantics in queue services (grouping + lock expiry + retries).
- If adding new message-flow steps, register them in `registerAllSteps()` and keep config contract (`requiredConfig`/`optionalConfig`) accurate.
- Preserve startup side effects in `main.ts` (step registration + worker startup) unless explicitly refactoring app bootstrap.

## Developer workflows used here
- Backend dev: `npm run dev` (ts-node-dev on `src/main.ts`).
- Legacy flow-builder frontend (deprecated): `npm run dev:frontend` (esbuild watch from `scripts/build-frontend.js`, output `public/dist/bundle.js`). Only touch this when the task explicitly targets flow editor assets.
- Full local ecosystem (Windows): `npm run start:all` (runs `scripts/start-all-services.ps1` + `services-config.json` sibling services).
- Redis helper scripts are available (`npm run redis:start|stop|logs|cli|stats|clear|monitor|ui`).
- There is no real test suite yet (`npm test` is placeholder); validate changes with targeted runtime checks/logs.

## Project conventions (not generic)
- TypeScript is strict (`tsconfig.json`) with `moduleResolution: NodeNext`; prefer explicit types over `any`.
- Formatting/style is tab-based with CRLF (`.editorconfig`, `.prettierrc`): tabs, width 4, max line 120.
- Common pattern: singleton service exports (`export default new ...Service()`), class-based controller exposing `router`.
- Most API endpoints use `/api/whatsapp/...` and protected routes commonly apply `isAuthenticated` middleware.
- Operational tracing uses `ProcessingLogger` for multi-step flows; keep log context (`instance`, process name, correlation id) when extending logic.

## Integration points to respect
- Environment-driven URLs connect to sibling services (`INSTANCES_API_URL`, `AUTH_API_URL`, `FILES_API_URL`, `SOCKET_API_URL`) from `.env`.
- Database is MySQL via Prisma (`WHATSAPP_DATABASE_URL`); schema/table names rely heavily on `@map`, so keep DB naming compatibility when editing models.
- `public/` + `/flows` SPA fallback in `main.ts` serve a legacy flow-builder UI. It is discontinued; prioritize backend/message-processing code unless the request is explicitly about flow editor screens.

## Good implementation examples in this repo
- Queue reliability and locking: `src/services/message-queue.service.ts`.
- Message distribution orchestration + flow/bot decisions: `src/services/messages-distribution.service.ts`.
- Step registration + contracts: `src/message-flow/register-steps.ts`.
- Multi-client provider factory behavior: `src/services/whatsapp.service.ts`.