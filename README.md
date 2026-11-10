# Absensi Karyawan WFH API

NestJS HTTP gateway and separate TCP attendance application, using shared MySQL and private same-host disk. The active public contract is draft 0.8.5. Authentication, employee/organization management and private file delivery run in the gateway. Tasks 022/023 add the attendance runtime, typed gateway client and RPC error boundary; task 016 adds the global schedule routes and service-owned saves; task 017 adds annual holiday batches; tasks 018/019 provide home, check-in/out, history and HR monitoring. Task 020 adds controlled CLI provisioning and deployment/recovery instructions. Startup never creates accounts or runs migrations.

The shared API source is [contracts](../contracts/README.md). Work and review status live in [the task index](../api-server-tasks/index.md); the selected architecture is in [the technical design](../api-server-tasks/api-server.technical.md).

## Runtime and dependencies

Use **Node 26.13.0** (`.nvmrc`) and **npm 11.20.0**. Direct dependency versions are exact and the lockfile is committed with approved changes. The engine check prevents accidentally installing with another Node major. No global Node installation is changed by this project.

```sh
nvm install
nvm use
npm ci
```

The selected stack is NestJS 12.3.3, `@nestjs/typeorm` 12.0.3, TypeORM 1.1.2, `mysql2` 3.24.6, MySQL 8.4.6 LTS, TypeScript 6.0.3, Jest 30.5.2, and ts-jest 29.4.15. The real-MySQL integration suite verifies this combination rather than relying only on declared peer compatibility. TypeORM 1.x uses mysql2 directly; its removed `connectorPackage` option is not used.

JWT/class-validator/class-transformer/Argon2 dependencies are installed for the subsequent modules. npm 11 install-script approvals are pinned for Argon2 and the Nest CLI watcher so clean installs reproduce their native setup. Configured JWT key format is an HS256 secret of at least 32 bytes; the signature test does not implement login or establish the production key-rotation policy. Browser allowlists are validated independently and wired by the shared task 004 HTTP setup.

## Configure local development

```sh
cp .env.example .env
```

Replace the database password placeholder and generate a separate JWT secret. Do not reuse a real employee password:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Secrets and `.env.*` files are ignored by Git; `.env.example` contains placeholders only. Explicit process environment variables override `.env`. Configuration uses Node's built-in env parser and is validated when Nest constructs the runtime module. `NODE_ENV=test` never implicitly loads the developer's `.env`.

Run Node.js directly and connect to a native MySQL 8.4 service at `127.0.0.1:3306` (or the host/port you configure). The API does not start or administer the database service. Use a dedicated development database and application user.

Connect with your MySQL administrator account and prepare the database/user, substituting a real local password before executing:

```sh
mysql --host=127.0.0.1 --port=3306 --user=root --password
```

```sql
CREATE DATABASE absensi_wfh CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'absensi_wfh'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_A_LOCAL_DATABASE_PASSWORD';
GRANT ALL PRIVILEGES ON absensi_wfh.* TO 'absensi_wfh'@'127.0.0.1';
```

Set the same application username/password in `.env`. Administrator credentials are used only for manual database setup; the API requires only `DB_USERNAME` and `DB_PASSWORD`. MySQL stores its data in the native service's data directory; the API never initializes or removes that directory. See [MySQL account setup](https://dev.mysql.com/doc/refman/8.4/en/creating-accounts.html) for account/privilege details.

Configure your development MySQL service for UTC, using its server configuration and normal service restart procedure:

```ini
[mysqld]
default-time-zone = '+00:00'
character-set-server = utf8mb4
collation-server = utf8mb4_0900_ai_ci
```

Verify the server/session setting with `SELECT @@global.time_zone, @@session.time_zone;`. Newly created connections should use `+00:00`; TypeORM also maps timestamps as UTC. The [MySQL timezone documentation](https://dev.mysql.com/doc/refman/8.4/en/time-zone-support.html) describes the server/session distinction. No server configuration or existing database is changed automatically by this project.

```sh
npm run migration:show
npm run migration:run
npm run build
npm run start:prod
# In a second terminal:
npm run start:attendance
```

## Environment settings

| Settings | Behavior |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production`; defaults to development |
| `HOST`, `PORT` | Bind IP/localhost and port; defaults to `127.0.0.1:3000` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` | Required connection identity/secret; port defaults to 3306; database name uses letters/digits/underscores |
| `DB_POOL_SIZE`, `DB_CONNECT_TIMEOUT_MS` | Defaults to 10 connections and a 10-second connection timeout |
| `JWT_ALGORITHM`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | HS256 only in this foundation; real non-placeholder secret required; issuer/audience required |
| `JWT_ACCESS_TTL_SECONDS` | Fixed 3600 seconds (one hour) |
| `CORS_ORIGINS`, `CSRF_TRUSTED_ORIGINS` | Separate comma-delimited origin allowlists; no wildcard/path/credential/query; HTTPS only in production; empty means no cross-origin trust |
| `STORAGE_ROOT` | Required private directory outside the application directory; relative paths resolve from `api-server/`; created with mode 0700 if absent; requires service ownership, owner-only permissions, safe ancestors and a durable write probe |
| `MAX_FILE_BYTES`, `MAX_CONCURRENT_UPLOADS` | Defaults to 5 MiB and four uploads; bytes cannot exceed the contract's 5 MiB ceiling; enforced by gateway admission and image validation |
| `IDEMPOTENCY_RETENTION_SECONDS` | Default/minimum 86400 seconds; bounded explicit cleanup is available through the operations CLI |

Password policy defaults are 15–128 characters. Environment policy changes must be reflected in the shared contract and published policy before release. Config validation reports setting names and constraints, never rejected values. Database/storage startup errors are sanitized; use a MySQL client and local operational logs to diagnose the actual service, rather than enabling SQL/credential logging.

Local evidence belongs on a persistent private disk, outside public/source directories. The example uses `../.local/absensi-wfh/files`. Keep that directory out of source control and PWA/static hosting. Production disk topology, backup/retention, TLS/proxy configuration, and scale are separate operational decisions.

## Build and run

```sh
npm run build
npm run start:prod
```

The build emits `dist/main.js`; production start executes that file. Startup validates configuration, connects to MySQL without retrying indefinitely, checks/creates the private root, and then listens. Shutdown hooks close Nest, RPC clients/listeners and each process’s connection pool. Readiness emits `Gateway ready.` or `Attendance ready.` only after dependencies initialize and its listener binds. Invalid configuration or an unavailable dependency fails before a successful listen; startup never runs schema synchronization, migrations, registration, or account seeds.

Task 003 uses the official TypeORM CLI: `migration:generate`, `migration:create`, `migration:show`, `migration:run`, and guarded `migration:revert`. Generate/show/run/revert build current source first. Update entities, generate/review a migration, register its class, then apply it. The database guide includes exact commands and the manual additions needed for CHECKs/triggers/data changes. Run only one migration process at a time; standard CLI output includes SQL and diagnostics. Startup checks connectivity without validating migration state and never creates or changes tables; run reviewed migrations explicitly before startup. `synchronize` and `migrationsRun` stay false. Read the [database task notes](../api-server-tasks/003-database-schema.md) for the 11-table active schema, migration permissions, append-only protections, empty-baseline rollback, and partial-DDL recovery. Migrations run explicitly before starting the API.

## Verification

```sh
npm run typecheck
npm run lint
npm test -- --runInBand
npm run test:e2e -- --runInBand
```

`npm run typecheck` runs TypeScript against the root configuration, including application source, unit tests and `test/` fixtures/e2e/integration suites; `build` intentionally excludes test files. Unit tests check runtime parsing/origin/secret/policy bounds. HTTP e2e fixtures use the production setup with the SQL provider replaced and temporary private storage; they verify validation/serialization, CORS/CSRF, request IDs/Problems, upload bounds, redaction and binary/204 behavior without publishing test routes in production. Real MySQL proof remains the integration suite. See the [HTTP task notes](../api-server-tasks/004-http-boundary.md) for DTO/guard usage, limits and error codes.

For the explicit integration suite, prepare a **dedicated empty MySQL 8.4 database with a name ending in `_test`** and put its `DB_*` settings, a test-only JWT secret/issuer/audience, and a private `STORAGE_ROOT` in ignored `.env.test.local`, with `NODE_ENV=test`. This suite never implicitly uses `.env`. It explicitly applies the test schema, verifies constraints and standard migration behavior, creates fictional rows inside rolled-back transactions, starts the actual Nest application, and verifies JWT plus native Argon2id imports. It does not create real accounts or change your existing service. The database guide describes migration privileges and test isolation.

```sh
npm run test:integration
```

The integration runner loads `.env.test.local` if present; CI can supply equivalent process environment variables instead. Do not point it at a production or populated business database. Task 002 verification used an isolated native MySQL 8.4.6 instance and direct Node processes; test data and temporary credentials were removed afterward.

Shared contract validation uses the separate Python environment described in [contracts/README.md](../contracts/README.md). Runtime foundation tests do not claim the 50 business operations are implemented.

## Dependency audit notes

The unused starter `@nestjs/mau` deployment dependency and its placeholder deploy command were removed, eliminating the observed high-severity findings in that toolchain. Nest CLI was updated to 12.0.12. The current production dependency audit reports zero advisories. The full audit still reports 20 development-tool findings (4 low, 16 moderate), principally in Jest transitive glob/minimatch/deepmerge dependencies; the registry currently suggests incompatible downgrades rather than a compatible patched Jest release. No forced downgrades or unverified major dependency overrides were applied. Review compatible fixes when upstream releases them; do not use the test toolchain with untrusted input.

The current foundation uses a fixed 1-hour stateless JWT configuration, UUID employees, credentials on employees and one normalized unique email column. Calendar locking and idempotency remain; audit/revocation/HR-guard/counter/preview-token/upload-tracking/deletion-job infrastructure is deferred. File workflows remain feature tasks; failed writes must commit no SQL changes, with direct cleanup on SQL failure and manual recovery for crash/deletion leftovers.

Task 004 configures `/api/v1`, strict HTTP validation, Problem errors, request IDs, private/no-store/nosniff, explicit CORS and built-in CSRF before init/listen. Task 006 now adds the auth/profile routes below. Unknown URLs outside the prefix also return a sanitized Problem. Transport JSON is limited to 1 MiB; multipart limits and typed parsing are documented in the HTTP guide. Serialization requires explicit public DTO/mapping; do not return ORM entities directly.

Task 005 adds IdempotencyModule/IdempotencyService for the eight contract mutations requiring Idempotency-Key. Boundary guards authorize and normal DTO pipes validate before controllers/handlers call a process-local runner. The runner passes its EntityManager explicitly to the business operation; idempotency has no authorization callback or interceptor. Fingerprints use parsed input/target plus SHA-256 file bytes. Normal success/status is replayed; employee creation stores only employeeId and reconstructs current initial credentials. Login/password and secret-bearing caching are refused.

A per-key MySQL connection lock and one SQL transaction commit business change plus receipt atomically. Live duplicates receive OPERATION_IN_PROGRESS; contention retries are bounded to three attempts with a stable receipt time. Retention is at least 24h; cleanupExpired(limit) performs explicit bounded SKIP LOCKED cleanup without a timer. All workers must coordinate on the same MySQL server. Actual feature eligibility, locks, upload staging and response mapping remain in their feature tasks. See [task 005](../api-server-tasks/005-transactions-idempotency-tokens.md) for the callback contract and verification. No per-module README is maintained.

Task 006 adds POST /api/v1/auth/login, POST /api/v1/auth/logout, POST /api/v1/auth/password and GET /api/v1/me. Use Authorization: Bearer for authenticated calls. Login returns a one-hour stateless JWT and explicit profile; logout discards no server state. Passwords use exact Unicode code points and Argon2id after the first change. Login limits are per process (10 email/IP attempts and 30 IP attempts per minute). See [task 006](../api-server-tasks/006-authentication-profile.md) for decisions and limits. Run unit tests with `npm run test:unit`; repository behavior is verified in the native-MySQL integration suite.

Task 007 adds authenticated GET/HEAD /api/v1/files/:fileId and internal parent-command image staging. FileService.withAtomicFiles stages all supplied files before the complete parent transaction/idempotency command (withStagedImage delegates for existing single-image callers); call attach inside that transaction and deleteReplaced after replacement commit. Current parent references and issued owner/HRD claims control reads. JPEG/PNG/WebP images are decoded with sharp (max 5 MiB and 16M pixels). Keep the POSIX storage tree private and persistent. Direct cleanup protects referenced evidence; crash/deletion leftovers require manual recovery. See [task 007](../api-server-tasks/007-local-private-files.md) for usage, limits and verification.

Task 008 adds HRD division/position list/create/PATCH routes under /api/v1/hr. Creates require Idempotency-Key; edits require expectedVersion. Literal code/name search, status/division filters and pagination follow the contract. Moving employee-referenced positions is blocked, and new assignments require an active division. Run `npm run migration:run` explicitly before deployment to widen organization codes to 40 characters; do this as a migration operation with writes paused. See [task 008](../api-server-tasks/008-organization-masters.md) for the rules, migration review and verification.

Architecture target: the HTTP application is the gateway. A separate NestJS TCP attendance process and transport/file adapters are planned in tasks 022–024; those entry points are not implemented yet. Organization stays gateway-owned and its controllers call LocalCommandRunner after the standard DTO pipe, passing EntityManager explicitly through the controller callback to the business method and repository. DTO validation runs once. Services return business results; HRD guards authorize once before replay. Never apply the local SQL runner around RPC. See [technical section 19](../api-server-tasks/api-server.technical.md#19-controller-called-idempotency-runner) for confirmed transaction ownership: attendance stores its mutation and receipt atomically in its own transaction; the gateway forwards the key and waits without a database transaction. Gateway-owned mutations retain their local receipts.

Transaction flow follows [the KISS design](../api-server-tasks/api-server.technical.md#21-kiss-transaction-implementation): one idempotency-owned local transaction, explicitly passed EntityManager, business write and COMPLETED receipt committed together. No async transaction context or implicit transaction reuse.

Idempotency outcomes: completed same-key/same-payload requests replay the original safe status/body; changed completed payloads return 422 IDEMPOTENCY_KEY_REUSED. Active keys return 409 OPERATION_IN_PROGRESS, including changed concurrent payloads; missing/malformed required keys return 400. Key scope is actor/operation/key. Different keys execute normal domain rules, and only expired completed receipts may permit fresh execution.

Task 009 adds HRD employee list/detail, multipart create/PATCH, role PUT and explicit initial-credential GET under /api/v1/hr/employees. Create and PATCH require Idempotency-Key; role PUT uses expectedVersion without a key. Create/role HRD grants require confirmHrAccess=true. Profile changes use expectedVersion, optional photo and removePhoto=true; omission keeps the existing photo. Creation receipts store only employeeId, and credential reads/replays serialize with self password change. Creation includes its optional photo in one multipart command; confirmHrAccess is canonical true/false text on create (JSON boolean on role PUT). Admission runs before multipart buffering. FileService.withAtomicFiles owns shared staging and reference-safe cleanup; EmployeeModule imports FileModule and uses the shared FileUploadInterceptor before multipart parsing. The callback awaits the existing local SQL/idempotency command, with no nested transaction. The shared lifecycle supports empty or multiple inputs; current file policies remain JPEG/PNG/WebP images. Future document support adds its validator/purpose/schema policy while reusing this lifecycle. No schema migration or attendance process is required. See [task 009](../api-server-tasks/009-employee-management.md) for behavior and verification. The local runner exposes a generic run method; controllers supply receipt work, optional presentation and status. Task 009 is complete and approved by the user.

EmployeeService delegates database reads/writes/row locks to repositories, matching the organization module; employee.service.spec.ts contains 44 business-rule unit tests with mocked dependencies. SQL concurrency and atomicity remain covered by native-MySQL integration tests.

Employee detail GET uses an unlocked committed read. Version-checked writes and initial-credential/password-change serialization retain their required row locks.

EmployeeRepository uses TypeORM find options with explicit division/position/photo relations and relationLoadStrategy=join, without QueryBuilder. EmployeeService maps the loaded relations directly. Normal detail/list reads open no transaction or row lock and perform no per-employee reference queries. Detail uses one SELECT; a nonempty paginated list uses three SELECTs (TypeORM's distinct-ID page query, its joined data query and the independent count query). List data/count run through Promise.all. Password/hash/storage-key columns are excluded; photo ownership/purpose/state are checked before projection. Relation mappings reuse the existing scalar columns and foreign keys without schema drift or a migration. Write-result reads reuse the owning command manager.

Employee assignment validation reads the position and its division in one joined repository lookup. The save transaction locks both rows and checks the requested division ID plus both active statuses.

## Separate attendance runtime (task 022)

The gateway uses `src/main.ts` / `AppModule`; attendance uses `src/attendance-main.ts` / `AttendanceAppModule` with `NestFactory.createMicroservice()` and `Transport.TCP`. These are separate OS processes. Attendance imports the database, runtime and focused access-token provider, with no gateway controllers, login endpoints or HTTP filters/guards. Each owns and closes its own SQL pool. `@nestjs/microservices` is pinned to 12.3.3, matching core/common/platform-express; its declared Nest peers accept 12.x.

Build once, then start each process in a separate terminal:

```sh
npm run build
npm run start:prod
npm run start:attendance
```

For simultaneous development, run **one** build watcher and two Node watchers, each in its own terminal. Wait for the first successful build before starting the Node watchers:

```sh
npm run build:watch
npm run start:gateway:dev
npm run start:attendance:dev
```

`start:dev` remains the gateway-only Nest watcher. Do not run it alongside `build:watch`; both write `dist/`. Use Ctrl-C or SIGTERM for each process to release listeners and pools. Migrations remain one explicit operator-controlled CLI, run before either app; neither startup applies migrations. Both applications validate RPC configuration. The gateway creates TCP connections only when a service-backed operation calls its client; startup and gateway-owned HTTP operations do not wait for attendance availability.

| Setting | Constraint/default |
| --- | --- |
| `ATTENDANCE_RPC_HOST` | `127.0.0.1` (default) or `::1` only; no wildcard, hostname or remote IP |
| `ATTENDANCE_RPC_PORT` | Independent port, default 4001, range 1–65535 |
| `ATTENDANCE_RPC_CREDENTIAL` | Required for both processes; separate non-placeholder server secret of 32–256 UTF-8 bytes; must differ from JWT secret |
| `ATTENDANCE_RPC_DEADLINE_MS` | Finite gateway wait budget, default 5000, range 100–60000 ms; enforced by the gateway client, including connection time |

Generate a separate random credential using the command above. Never expose it, the JWT secret, or private paths to the web client. Loopback is the accepted same-host trust boundary; remote deployment requires a new TLS/network/storage decision.

### Internal v1 protocol

`src/attendance-rpc/rpc.contract.ts` defines the pattern constants and named envelopes. `rpc.inputs.ts` defines scalar/nested validation DTOs. `rpc.responses.ts` contains response types derived from the active public schemas without changing them; keep these types aligned with approved contract changes. This is an internal TypeScript contract, not another public HTTP schema.

A request is `{version: 1, requestId, serviceCredential, accessToken, input}`. `requestId` is the original UUID correlation ID, `accessToken` is the original stateless access JWT, and write envelopes additionally require the original UUID `idempotencyKey`. The check-in envelope carries `fullUploadReceivedAt` (ISO instant) and a validated `StagedCheckInImage` descriptor from `rpc.files.ts`. No image buffers/base64, request/Multer objects, entities, SQL managers or client-supplied paths cross TCP. Staging IDs and transport fields must stay out of command fingerprints.

| Pattern prefix `attendance.v1.` | Input / response | Handler owner |
| --- | --- | --- |
| `schedule.get` | EmptyInput / WorkSchedule | 016 |
| `time-zones.list` | TimeZonesInput / TimeZoneChoices | 016 |
| `schedule.preview`, `schedule.change` | ScheduleInput / SchedulePreview, ScheduleChanged | 016 |
| `schedule.versions` | PageInput / ScheduleHistoryPage | 016 |
| `holidays.get` | HolidayYearInput / HolidayCalendar | 017 |
| `holidays.preview`, `holidays.change` | HolidayChangeInput / ChangeImpact, HolidayChanged | 017 |
| `home.get` | EmptyInput / Home | 018 |
| `check-in` | CheckInEnvelope with descriptor from 024 / Attendance | 018, 024 |
| `check-out` | CheckOutInput / Attendance | 018 |
| `days.list` | AttendanceDaysInput / AttendanceDayPage | 019 |
| `record.get`, `hr-record.get` | AttendanceRecordInput / Attendance | 019 |
| `monitoring.list` | MonitoringInput / MonitoringPage | 019 |
| `file-access` | FileAccessInput / internal FileReadDescriptor after committed association authorization | 024 |
| `command-outcome` | CommandOutcomeInput / actor-scoped COMMITTED receipt or UNKNOWN | 024 |

No production business handler or probe endpoint is registered by task 022. Owning feature tasks register `@MessagePattern(ATTENDANCE_PATTERNS...)` handlers, use concrete class DTOs with `@Payload('input')`, and obtain verified actor claims through `rpcActor(@Ctx() context)`. The standalone global pipeline validates envelope/version/key, authenticates the gateway credential and JWT, checks HRD claims for HR patterns, then validates the input DTO **once** before handler/runner execution. DTOs reject unknown fields, null optional values, implicit scalar coercion, malformed UUID/date/time strings and out-of-bound arrays/pages/queries. Domain decisions (supported IANA zones, date ranges, holiday consistency, scheduling rules) remain owning service work. No role/status DB lookup or revocation is introduced.

RPC faults are `{version: 1, code, kind, status, message}` with code/kind/status combinations defined in `rpc.fault.ts`. Foundation codes are `RPC_INVALID_ENVELOPE`, `RPC_UNSUPPORTED_VERSION`, `RPC_UNAUTHORIZED`, `RPC_FORBIDDEN`, `RPC_VALIDATION_FAILED`, `RPC_RESPONSE_TOO_LARGE`, `RPC_INTERNAL_ERROR`; unexpected errors and arbitrary exception text are sanitized. The task 023 adapter maps known faults to HTTP Problems and preserves token challenges; see below. Attendance startup diagnostics exclude settings' values and driver errors.

The Nest TCP frame buffer is capped at 256 Ki characters; envelope validation also caps JSON at 256 KiB UTF-8. The response serializer caps the entire response packet at 2 MiB UTF-8, returning a bounded fault on overflow. Partial frames have a 5-second idle / 10-second total receive limit; non-reading peers have a 2 MiB send-buffer cap and 5-second drain limit. Clients must use `send()` request-response and the configured finite deadline. A timeout does not cancel a write or prove rollback; attendance mutations/receipts stay process-local and uncertain image/outcome recovery belongs to task 024. There is no gateway SQL transaction around TCP.

The integration suite uses test-only handlers over real TCP/MySQL and starts both production entry points as separate processes. It checks credential/JWT/version/DTO rejection before handler work, response redaction and bounds, oversized frame rejection, occupied-port failure, SQL/socket shutdown, reconnect, and gateway HTTP availability with attendance absent. These are foundation checks; real business concurrency and cross-process evidence remain tasks 020/021.

## Gateway attendance client and failure mapping (task 023)

`GatewayAttendanceModule` is imported by the HTTP application and exports `AttendanceClient`. Feature modules import it and call `client.call(ATTENDANCE_PATTERNS..., request)` after HTTP guards and their normal DTO pipe. `gatewayRpcContext(request, response)` extracts the original JWT and current UUID request ID. Requests supply their validated `input` and, for writes, the original UUID `idempotencyKey`; the client supplies the pinned version and server-only credential, ignoring any caller overrides of transport/actor fields. No HTTP controller for a future feature is registered by this task.

Each attempt creates one bounded TCP client, subscribes to `send()` once, and closes/destroys that attempt's socket in `finally`. The finite deadline includes connecting. Connections are not pooled or automatically retried; independent attempts do not cancel each other's sockets. Module shutdown closes outstanding sockets and rejects new attempts. The client receives no DataSource/manager/runner and opens no SQL transaction or receipt around RPC. A new attempt after a service restart creates a fresh connection.

Reads return the declared DTO. Mutation replies use internal `RpcCommandReply<T> = {status, body, replayed}`; the handler returns its attendance-local runner result **after commit**. The owning HTTP controller applies status/replay headers and returns `body`, preserving the existing public success shape. Staged check-in descriptors and file-access/outcome DTOs remain task 024 work; those reserved operations are not callable through the typed facade yet.

| Failure | HTTP behavior |
| --- | --- |
| Read connection loss/unavailable/unknown remote response | 503 `ATTENDANCE_SERVICE_UNAVAILABLE` |
| Read deadline | 503 `ATTENDANCE_SERVICE_TIMEOUT` |
| Lost/late write reply or unclassified internal write failure | 503 `ATTENDANCE_OUTCOME_UNKNOWN`; retain original key/input and potentially in-use staged bytes |
| Explicit service-credential denial or a locally closed client before dispatch | 503 `ATTENDANCE_SERVICE_UNAVAILABLE` |
| Service JWT invalid/expired | 401 `TOKEN_INVALID` / `TOKEN_EXPIRED`, with gateway Bearer challenge |
| Known role/DTO/business/helper fault | Declared status/code; 409/422 idempotency outcomes and bounded Retry-After preserved |
| Internal protocol mismatch or unexpected read failure | Sanitized 500 `INTERNAL_ERROR` |

`RpcFaultFilter` converts declared `ProblemException` failures from existing local helpers and explicit RPC exceptions into a serializable discriminated fault union. Code, kind and status must match a fixed definition; messages come from the code registry. Optional field errors accept only bounded known DTO paths and canonical messages (at most 32); details accept nonnegative safe `expectedVersion`/`actualVersion` numbers; Retry-After is bounded to 1–60 seconds. Unknown exception text/details, SQL, stacks, disk paths and tokens are discarded. The gateway validates the same fault mapping and never infers codes from arbitrary Nest/driver message strings. The receiver rejects malformed correlation packets and byte-oversized responses without logging their payloads.

The service still validates credentials/JWT/HR claims before the handler and validates the concrete operation DTO once through its normal RPC pipe. Owning features add resource-access guards before receipt disclosure; no authorize callback, repeated role check in a business service, revocation/status lookup, or transaction crossing TCP is introduced. A client deadline stops waiting and closes its socket; Promise-based remote work can still commit. Recover/replay the same command with its original key; do not create a replacement key to escape uncertainty. Check-in byte retention and committed-result lookup remain task 024 responsibilities.

Shared contract draft **0.8.1** adds 503 declarations and Problem examples for service-backed operations, including future attendance-evidence authorization on file GET. It changes no public success schema/path. The Postman collection retains static success examples. The full checks pass: **262 unit**, **12 HTTP e2e**, **81 real MySQL integration** tests, build, lint, and `npm run typecheck` including all test files. The new integration probes exercise HTTP → real TCP → attendance-local MySQL receipts, commit/lost-reply/same-key replay with exactly one effect, changed-input 422, ownership/HR/JWT-expiry and DTO guard ordering, deadlines, unknown patterns, service absence/restart, and gateway-owned route independence. Probes are test-only and implement no production attendance business behavior.

The explicit integration environment now also requires a test-only `ATTENDANCE_RPC_CREDENTIAL` (32–256 bytes, different from the JWT secret). Normal HTTP e2e fixtures override only their test configuration; production never uses a test fallback credential.

## Attendance calendar calculations (task 010)

`WorkCalendarModule` belongs to `AttendanceAppModule` and exports `CalendarService`; the HTTP gateway has no second calendar engine. It reuses the existing injectable `Clock` and the pinned Node 26 native Temporal implementation. TypeScript enables `ESNext.Temporal` types without adding a polyfill or package dependency. Native support is documented in the [Node 26 release](https://nodejs.org/en/blog/release/v26.0.0); local-to-instant conversion uses Temporal's [reject disambiguation](https://tc39.es/proposal-temporal/docs/timezone.html) for gaps/folds.

`calendar-time.ts` separates strict YYYY-MM-DD dates, HH:mm local times and explicitly offset/UTC instants. Supported named IANA zones are canonicalized through the runtime's ICU; literal numeric offsets cannot replace a zone. ISO weekdays are Monday=1 through Sunday=7. Schedule wall-clock duration must be positive and below 24h; UTC elapsed duration follows actual zone offsets. Dated start/end and future activation midnight are resolved independently with `disambiguation: reject`, including half-hour transitions and skipped whole dates. Dates and returned UTC instants never depend on the host process TZ. Dated intervals are revalidated when calculated; a recurring schedule does not reserve all future DST occurrences.

`preview()` compares effectiveFrom with today in the proposed **new** zone. Today yields `{activationMode: ON_SAVE, effectiveAt: null}`; future dates yield AT_INSTANT at strict new-zone midnight. `planSave()` returns the supplied/injected save instant as `saveAt` (also the pending cancellation instant), identifies the single pending ID to cancel, and for ON_SAVE identifies current to close (`closeCurrentId`). The owning schedule command in task 016 must compute this again after acquiring its calendar lock, apply those metadata changes and append history together with the new version/receipt. For future replacement, keep current coverage until the new activation, avoiding an obsolete old-pending cutoff. No save SQL, lock/transaction runner, token or reservation is added by task 010.

Saved timeline reads derive current from the latest activated version and upcoming from its nearest successor, without updating rows/cron. Superseded-at/before-activation rows never became active and are excluded. Explicitly ended intervals do not resurrect older versions. Historical observation can have several later activations; only save planning enforces the one-pending-at-save-time invariant. Conflicting equal activation instants are rejected rather than resolved by an arbitrary ID.

For an **unrecorded date**, use the latest UTC activation whose local activation date in its own zone is on/before that date. An ON_SAVE replacement applies to its whole unrecorded day, while older dates retain the saved definition. Missing first/historical coverage is SCHEDULE_NOT_CONFIGURED; there is no backward extrapolation. Owning history features may present UNCONFIGURED. Historical range/account/import policies remain tasks 019/020. `readSnapshot(date, recorded)` copies the persisted snapshot verbatim before any calendar lookup, preserving even an open overnight attendance after zone changes. Returned definitions, weekday arrays, save plans and snapshots are detached/frozen.

`readDay()` uses the starting workDate for ISO weekday and holiday/year lookup. Holiday takes precedence over a rest day; these nonworking days need no planned interval, while a working day gets a strict UTC snapshot. A 31 December 22:00–06:00 shift belongs to 31 December even though local checkout is 1 January. Holiday edits use today in the **currently active** zone, never a pending/proposed zone; without an active schedule the cutoff is rejected rather than guessed.

Persistence reads live in `CalendarRepository` with TypeORM find options. A one-day projection uses exactly two independent SELECTs (timeline and holiday), snapshots/current use one SELECT, and recorded-snapshot preservation uses none. Reads create no transaction or write; an explicitly supplied EntityManager passes through to both queries. Results are uncached so a rolled-back proposal never changes subsequent committed reads. Feature commands remain responsible for calendar locks, version checks and one local mutation/receipt transaction.

The full regression passes **333 unit**, **12 HTTP e2e** and **88 native MySQL integration** tests, plus build, type-aware lint and TypeScript including all tests. The 70 calendar unit cases also pass in independent UTC, Asia/Jakarta and America/New_York processes. Seven calendar integration cases exercise the real production providers over test-only TCP patterns, validate result fragments against shared contract examples, verify query counts/manager isolation, persist and preserve an actual attendance snapshot, and check missing coverage/DST fault mapping. Contract draft **0.8.2** validates 32 operations, 60 schemas and 47 fixtures. Public schedule/calendar/home/check-in/history handlers still belong to tasks 016/017/018/019; task 010 adds no production route or RPC handler, migration, seed or gateway-side calendar business rule.

## Company-wide work schedule API (task 016)

Five production HTTP operations now call the attendance service through the typed gateway client: GET `/work-schedule`, GET `/reference/time-zones`, POST `/hr/work-schedule/preview`, PUT `/hr/work-schedule`, and GET `/hr/work-schedule/versions` (all under `/api/v1`). Authenticated EMPLOYEE/HRD claims can read schedule/timezone choices; preview/save/history require issued HRD claims at both boundaries. `HrGuard` is shared by the HTTP features; the existing OrganizationGuard name is a compatibility export. Controllers handle transport and contain no database calls, private helpers or business rules. Attendance owns the service/repository and local runner; gateway never starts a SQL transaction or stores a receipt around RPC.

Unconfigured GET returns resource version 0, null current/upcoming and the contract check-in policy; it invents no schedule or account. A valid preview returns schedule/activation/validation issues without locks or writes. Stale expectedVersion is `impact.canApply=false` with VERSION_CONFLICT. Invalid duration, zone, past date or ambiguous/nonexistent activation returns the declared 422 Problem because no valid activation DTO exists. A preview never reserves a time or bypasses save-time checks.

The existing local runner owns the mutation/receipt transaction. ScheduleService first locks `calendar_state(id=1)`, checks expectedVersion and obtains a fresh clock after that lock wait. It applies task 010's save plan, inserts the new saved version, marks replaced current/pending metadata, advances the monotonic global calendar basis and appends SAVED/SUPERSEDED history events; the runner then stores the completed safe response and commits. All repository calls receive that explicit EntityManager. Recorded attendance rows/snapshots are untouched. No nested transaction, remote call or stored preview token is added.

Independent reads in `get()`/`history()` and independent history-event persistence/response lookup after dependent mutations use `Promise.all`. The calendar lock, version insert, supersession and resource-version writes stay ordered. An event write failure rolls back schedule/version/history/receipt together. The generic runner remains unchanged. A committed response lost on TCP returns ATTENDANCE_OUTCOME_UNKNOWN; replaying the same original key/canonical payload returns its committed status/body/replay flag without another version/event. Canonical weekday sets are sorted; other parsed input fields remain part of the fingerprint. Guards and DTO validation still run before replay; fresh domain/date/version checks do not run again for successful replay.

Schedule/actor projections use TypeORM find options with a relation join on the existing created_by foreign key, selecting only actor ID/fullName. No schema migration or credential lookup is needed. GET uses two SELECTs in one attendance-local REPEATABLE READ snapshot so resource version and timeline/actor data agree. Nonempty paginated history uses four SELECTs (global state projection, distinct page IDs, joined page data, independent count) in the same read snapshot, with no per-version actor queries. Versions order by effectiveAt descending then ID ascending; canceled future rows remain SUPERSEDED in history. The current/upcoming projection still loads the company timeline; further history-volume optimization belongs to operational needs. Preview's single version read needs no read transaction.

Timezone search uses supported primary IANA IDs plus UTC, case-insensitive ID/city text, and UTC noon on atDate (default current UTC date). Labels/offsetMinutes are informational; actual dates/intervals always use task 010's IANA/Temporal calculations. Very old offsets with seconds or outside the existing +/-14h integer-minute display DTO are omitted rather than rounded or clipped. No configuration is required to search zones.

The test suite passes **354 unit**, **12 HTTP e2e**, **98 native MySQL integration** cases, build, type-aware lint, formatting and root TypeScript checks including all tests. Actual successful responses for all five operations were separately validated against OpenAPI's WorkSchedule, TimeZoneChoices, SchedulePreview, ScheduleChanged and ScheduleHistoryPage schemas. Ten feature integration cases exercise the actual gateway/controllers/client/TCP/service/SQL pipeline, concurrent different-key saves, exact activation, pending replacement/history/snapshot preservation, lock-wait midnight revalidation, atomic rollback, lost-reply replay and pre-replay role/DTO denial. Existing schema checks confirm no metadata drift. Foundation probes import only their core RPC providers so they cannot replace real schedule handlers.

Integration uses a dedicated `_test` database with empty schedule history. The schedule fixture refuses pre-existing event history and resets only that isolated test history via TRUNCATE during teardown because production UPDATE/DELETE is blocked by append-only triggers. Neither application truncates history or executes migrations at startup. Shared draft **0.8.3** retains 32 operations/60 success schemas and validates 48 examples; the task 016 behavioral additions are approved. Holiday/calendar batch changes, attendance commands/history and operations/bootstrap remain later tasks.

## Annual holiday API (task 017)

The gateway exposes authenticated `GET /holidays?year=YYYY`, HRD `POST /hr/holidays/preview`, and HRD `POST /hr/holidays/changes`. All three delegate to the corresponding authenticated/validated attendance TCP handlers. The generic local runner owns apply transactions and completed receipts; gateway/controller code contains no calendar SQL or private business helper.

Annual reads return version 0/items=[] before the first batch and require no schedule. Version/items are read in one consistent snapshot with two SELECTs; previews read the annual resource/timeline consistently with three SELECTs and independent I/O through Promise.all. Preview returns advisory ChangeImpact issues for stale versions, empty/wrong-year batches, duplicate/overlapping dates and past dates. Preview/apply require an active schedule (409 SCHEDULE_NOT_CONFIGURED) to determine today's company date.

Apply acquires calendar_state before capturing the current clock and checking the active schedule zone and annual expectedVersion. It rejects stale versions with 409 VERSION_CONFLICT and invalid batches with 422 HOLIDAY_BATCH_INVALID, DUPLICATE_DATE or PAST_DATE_IMMUTABLE. Today/future entries are eligible. Only supplied dates change; removing an absent date is permitted. Annual resource versions are independent per year. Every accepted nonempty batch advances the annual version and global WorkSchedule.version basis, committing changes and receipt together. Dependent writes remain ordered. No migration, startup seed, implicit full-year replacement, preview token or attendance rewrite is added.

Upsert entries and remove dates are sorted by date for the canonical fingerprint; exact names/categories are retained. Original-key replay returns the committed result after guards/normal DTO validation, even if its dates are now past. Shared draft 0.8.4 documents these details without changing public success schemas. Task 016 is approved/committed as `8b9c6b2`; task 017 is approved by the user.

Validation passes **372 unit tests**, **12 HTTP e2e tests**, **117 native MySQL integration tests**, build, type-aware lint, formatting and TypeScript including tests. The 19 new MySQL cases cover actual HTTP→TCP handlers, query counts/no gateway SQL, add/rename/remove/untouched dates, annual independence, first-year races, schedule/holiday coordination, midnight/year/active-zone boundaries, lock waits, unchanged attendance snapshots, rollback after deletion, lost committed replies/sorted replay, authorization before replay, malformed HTTP/raw RPC and outage/restart. Actual annual/preview/change/Problem responses validate against the shared schemas; the shared validator passes 32 operations, 60 schemas and 51 fixtures. Production check-in handlers remain task 018; coordination here verifies the common SQL lock and actual schedule commands, without claiming check-in is implemented.

### Private evidence across processes

Task 024 supplies file infrastructure; task 018 now registers the production home/check-in/checkout routes described below. On that multipart route, order interceptors as `FileUploadInterceptor`, Multer, then `UploadReceiptInterceptor`. Pass its pinned `fullUploadReceivedAt`, issued actor ID, original key and RPC context to `RemoteImageService.checkIn`. The gateway validates and durably stages one image, then sends its descriptor; no gateway transaction spans TCP.

The attendance handler must accept `@Payload('stagedImage') image: StagedCheckInImage`, call `AttendanceFileService.verify(image, actor, receivedAt)` before the runner, then use `checkInCommand` and one local runner/manager for photo metadata, attendance and receipt. `verify` independently decodes the actual bounded private file and matches its digest/name/MIME/key/owner/timestamps. Check-in fingerprints contain empty business input plus the `photo` digest, excluding attempt IDs, filenames, keys and times.

`RemoteImageService` retains bytes after unknown/5xx outcomes or active-key conflicts. Confirmed success/replay or explicit 4xx rejection permits a remote reference check; only `FILE_NOT_FOUND` then permits deletion of that freshly generated unused candidate. An unavailable reference check retains bytes. Never reuse a staged descriptor for a separate command. The internal `command-outcome` lookup takes `{operation,key,fingerprint}`, scopes receipts to the issued actor, and requires HRD for calendar operations. It returns `{state:'COMMITTED',status,body,resourceId}` or `{state:'UNKNOWN'}` without locks or new receipt states. A retained matching completed receipt remains recoverable until removed/replaced; UNKNOWN never authorizes cleanup. Preserve the original key/input for replay; unresolved crash leftovers need manual recovery.

File GET/HEAD dispatches using persisted purpose. Profiles retain local authorization; check-in evidence calls attendance `file-access`, whose single query checks the committed matching owner/attendance association. The gateway only opens/streams authorized private bytes, with no attendance-table fallback. Attendance outage returns safe 503 for evidence and leaves profile reads available. `PrivateStorageModule` is shared by both apps without importing HTTP controllers into attendance. No migration, worker, cleanup table or public upload/outcome endpoint is added.

### Attendance home and commands

The gateway now serves GET `/api/v1/me/home`, multipart POST `/api/v1/me/attendances/check-in` (one required `photo`, no text fields), and JSON POST `/api/v1/me/attendances/{attendanceId}/check-out` (`{expectedVersion}`). Both writes require a UUID Idempotency-Key and return Idempotency-Replayed. Issued EMPLOYEE/HRD claims act only on their own attendance; checkout ownership is checked before replay. Authentication remains stateless with no current-account role/status lookup.

Home is advisory and returns company date/zone, current schedule, authoritative windows and relevant actual attendance. Open overnight records take precedence. Initial unconfigured display uses UTC and remains blocked. Check-in resolves fresh eligibility using the server's complete-upload receipt, permitting start-minus-15-minutes <= receipt < planned end. At/before start is on time; later milliseconds are late with at least one reported second. The gateway pins receipt before validation/storage/RPC/SQL waits; client identity/timestamps/status are rejected. Rest/holiday dates skip shift-time resolution; required ambiguous/nonexistent local shifts return 422.

Attendance owns one transaction for check-in metadata, snapshot, attendance and receipt. A shared calendar lock coordinates with calendar saves, and an employee lock coordinates distinct attendance keys/checkout. Completed replay preserves its original photo/time; use home for current state. Unknown outcomes retain the original key/input and potentially used bytes as described above. Checkout uses service time, expectedVersion and the original snapshot, floors duration seconds, increments version and cannot close twice. Current calendar changes never recalculate recorded attendance. File/photo relation joins reuse the existing schema; no migration is needed.

Business services/helpers/guards have unit tests; production HTTP/TCP routes also run in two actual OS processes against isolated native MySQL and real images. Integration covers calendar/attendance races, loss/timeout recovery, exact millisecond and multipart/lock-wait boundaries, overnight/year-end/zone/DST behavior, immutable snapshots and query counts. History and monitoring are available through task 019 below.

### Attendance history and HR monitoring

GET `/api/v1/me/attendance-days?from=YYYY-MM-DD&to=YYYY-MM-DD` returns newest-first dated projections and real attendance; GET `/api/v1/me/attendances/{attendanceId}` returns the signed-in owner's actual record. GET `/api/v1/hr/attendance-days?date=YYYY-MM-DD` and GET `/api/v1/hr/attendances/{attendanceId}` require issued HRD claims at both HTTP and RPC boundaries. Missing/inaccessible records return 404. No read writes attendance or activates schedules.

Review baseline: history includes at most 366 inclusive dates, omits projected pre-creation dates and preserves all actual rows, including imported older records. Dates before saved schedule coverage project UNCONFIGURED. Monitoring includes active accounts created by the selected work date and inactive accounts with an actual record on that date. Account visibility uses current status; historical expected days for inactive accounts are not inferred. Actual states, snapshots, durations, punctuality and photo evidence are preserved across calendar changes.

Monitoring supports `q` (literal UUID/name substring), `divisionId`, primary `status`, `punctuality`, `page` and `pageSize`. Filters apply before pagination and all summary totals; late overlaps WORKING/COMPLETED. Sort is fullName/UUID ascending; page defaults are 1/20, max 100. Employee summaries expose current safe name/division/position/profile references, including inactive masters. Multi-query reads share a consistent snapshot: history four SELECTs, populated monitoring six, actual detail one, with no gateway attendance SQL or credential selection. File metadata retains the existing contentPath; profile bytes remain independent during attendance outage. History/account visibility decisions are documented in shared contract draft 0.8.5 and task 019 for review.

## First-HRD provisioning and operations (task 020)

Use the built gateway-owned CLI once after reviewed migrations, with both writers stopped. It creates one active HRD and its active division/position in one transaction. A lock on the installation singleton serializes concurrent provisioning; a nonempty employee table is refused, including installations containing only inactive employees. Existing accounts and calendars are never reset. Organization-code collisions fail the transaction. Store the operator-chosen initial password according to the existing first-login model; it is replaced by Argon2id on the first password change. Output contains only the employee UUID. Errors omit input, driver details and private paths.

Run the interactive command in a private terminal, including on production:

```sh
npm run build
NODE_ENV=production npm run seed:hr
```

The command asks for HR full name, email, initial password and confirmation, division code/name, and position code/name. Enter your own values at runtime. Both password entries are hidden; Ctrl-C cancels before any database changes. Email is trimmed/lowercased, and initial provisioning passwords require 8–128 Unicode code points without trimming. Self-service password changes retain the contract’s 15–128 policy. No production HR identity or password is embedded in source code. `seed:hr` also works in development/test and delegates to `operations -- provision-first-hrd --confirm-empty-installation`. Run reviewed migrations first; neither server needs to be running.

For scripted deployment, the same command optionally accepts a JSON object on stdin (up to 16 KiB) with exactly `fullName`, `email`, `initialPassword`, `divisionCode`, `divisionName`, `positionCode`, `positionName`:

```sh
NODE_ENV=production npm run seed:hr < /private/operator/provision.json
```

Keep scripted input in a mode-0600 file inside a private directory and remove it according to host policy after confirming login. Keep credentials out of command arguments, shell history and logs, and have the HRD change the initial password. No password is generated or printed by the CLI. A failed/lost CLI output can be checked by an operator in SQL; do not rerun to reset an existing account. There is no public bootstrap/reset endpoint.

Only the separate `NODE_ENV=development npm run operations -- seed-development --confirm-fictional-data` command substitutes fictional account/organization identities (`fictional-hrd@example.test`, DEMO division). It accepts the same interactive or JSON input, retains the supplied test password, requires an empty installation and refuses test/production environments. It adds no schedule, holidays, attendance or time-off rows. Neither application startup invokes it.

For bounded receipt maintenance, use one explicit operator invocation:

```sh
npm run operations -- cleanup-receipts 100
```

Each invocation deletes at most the requested 1–1000 expired COMPLETED receipts, ordered by expiry/ID, skipping locked rows. It prints only the deleted count. Retention is at least 24 hours after completion. Cleanup never deletes IN_PROGRESS records, evidence bytes, attendance or history. Reusing a key after receipt expiry can execute again; resolve uncertain outcomes before receipt expiry and postpone cleanup while investigating them. No scheduler or durable recovery worker is installed.

### Native process deployment

Build once with the pinned runtime. Stop both writers and run **one** reviewed `migration:show`/`migration:run` CLI before starting either process. Check that no pending migration remains; startup deliberately performs no schema synchronization or migration. Keep a coordinated backup before DDL: MySQL DDL is not generally rolled back with application transactions, and `migration:revert` is restricted to an empty baseline.

Supervise `node dist/main.js` and `node dist/attendance-main.js` as separate services using the host's launchd/systemd equivalent. Set an absolute working directory to `api-server/`, the pinned absolute Node path, the same service UID, a 0077 umask, persistent storage, restrictive environment-file permissions, bounded log rotation and restart backoff. Supply environment via the supervisor or the repository's private `.env`; npm start aliases are conveniences. Do not put secrets in process arguments or supervisor stdout. Run one instance of each initially; establish capacity before increasing replicas. No Docker, broker or cross-host filesystem is part of this deployment.

Gateway HTTP should bind loopback behind an HTTPS reverse proxy. Preserve the original `/api/v1` prefix and Authorization/Origin/Sec-Fetch-Site headers, and forward request bodies without automatic command retries. Configure exact public web origins independently in CORS_ORIGINS and CSRF_TRUSTED_ORIGINS. Trust proxy remains false: forwarded IP/host/protocol headers are not trusted, so login limits see the proxy's socket address. Keep the proxy upstream private; use proxy connection/body limits and timeouts that allow upload completion plus the RPC deadline. Never expose STORAGE_ROOT as a static directory or log auth/body/query content. Correlate using validated response X-Request-Id; the same UUID travels in the RPC envelope and safe Problems. The app emits safe lifecycle messages, sanitized Problem code/request-ID records and cleanup warnings; optional host instrumentation must retain that restriction.

Both processes need identical DB identity, STORAGE_ROOT and JWT algorithm/secret/issuer/audience/3600-second TTL. Keep the independently generated ATTENDANCE_RPC_CREDENTIAL identical across both services and different from JWT_SECRET. Use the same loopback host/port and finite deadline settings listed above. Restrict host accounts: loopback is not encryption. Separate machines, separate databases, different service UIDs or multiple roots require a new deployment design.

Pre-create a persistent owner-only directory owned by the common service UID. Both applications check that root is a real directory (no root symlink), owned by that UID, with no group/other permissions. Ancestors must not be group/world writable unless sticky. Both check read/write/traversal and exclusive mode-0600 probe creation, write, fsync and removal. Existing permissions are never silently broadened/repaired. Protect ancestors from renames and retain the same mount/root identity while processes are running. Run probes under each actual service identity; successful gateway startup alone does not establish attendance's filesystem visibility. Monitor disk capacity/inodes and mount identity externally; the probe cannot guarantee future writes or detect a writable replacement mount after a full restart.

Readiness is independent per process: wait for its safe ready line, then probe gateway-owned authenticated `/api/v1/me` separately from attendance-backed `/api/v1/me/home` (with a controlled short-lived test credential). A TCP connect alone verifies a listener, not authorization/SQL/handlers. There is no new public health operation. Attendance can be down while login, organization, accounts, profiles and profile images continue working. Calendar/attendance reads and evidence authorization return scoped 503 errors. Gateway never falls back to writing attendance tables.

Graceful stop: stop proxy admission, allow in-flight requests to finish, SIGTERM gateway and attendance, and wait for both exits before maintenance. Use a supervisor grace period longer than the longest RPC deadline plus TCP drain (5 s) and a margin for SQL/file completion. Gateway clients close on completion/deadline and shutdown; attendance closes its listener/sockets; TypeORM releases each pool. If forced termination is necessary, wait for database sessions/transactions/locks to drain before recovery. A deadline or terminated connection is not evidence of rollback. Restart either process independently; new requests open new TCP clients and can reconnect after attendance returns.

The shared database has logical ownership: gateway writes accounts/organization/profile metadata and its receipts; attendance writes schedule/holiday/attendance/evidence association and its receipts. The operations CLI coordinates only provisioning or bounded receipt cleanup. No gateway transaction spans an RPC. Each pool defaults to 10 connections (maximum 100), so budget both processes plus CLI/migration/admin connections. Gateway upload admission defaults to four concurrent uploads, maximum 32, each at most 5 MiB; budget buffers and image decoding overhead. RPC requests/responses are bounded at 256 KiB/2 MiB, with receive/buffer/drain timeouts; these byte bounds do not limit simultaneous RPC handlers. Enforce host/proxy concurrency and connection limits and measure load before deployment. No distributed admission or automatic retry loop is provided.

Synchronize the single host's clock with a monitored time service and alert on clock jumps. JWT validity, receipt retention, upload receipt instants and attendance calculations use server time; configured IANA company zones determine work dates. Don't change the clock to repair attendance. Disk errors fail writes before SQL commit where possible; known committed metadata with unreadable bytes yields a safe 503 and requires restoring the bytes. MySQL loss makes SQL-dependent work unavailable; restore the database before restarting writers. Do not convert availability errors into absent attendance or delete evidence to resolve them.

### Coordinated SQL and file backup/restore

1. Stop external admission and **both** writers, including operations/cleanup/migrations. Wait for process exit and inspect SQL sessions to establish there is no in-flight command/transaction or open writer to private disk. Resolve or record all uncertain outcomes with their original key, actor, operation and canonical input. Do not clean receipts during investigation.
2. Back up the full application database, migration table and triggers with the native MySQL 8.4 `mysqldump --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF` into an access-controlled SQL file. Use an operator's protected MySQL option file/login path or secret-injected environment; no password argument. Copy the **entire** private root, including unreferenced staged candidates, into the same private backup set, preserving permissions. Keep writers stopped across both copies; a standalone online SQL dump plus a later disk copy is not a coordinated snapshot.
3. Record backup time, schema/runtime build, database identity and file checksums/permissions privately. Protect and encrypt the backup at rest using host tooling: SQL includes initial credentials, hashes and retained receipt bodies, and disk includes personal images. Restart only after both copies succeed. Define backup frequency and recovery objectives with the deployment owner.
4. Rehearse in an isolated same-host environment using a disposable `_test` database and a separate mode-0700 root. Restore **both** halves from one backup set, including triggers/migration state. Never overlay one snapshot's SQL with another snapshot's files. Configure isolated ports/secrets/UID visibility before starting both processes. Keep production admission closed during a real restore.
5. Verify login and changed-password state, profile bytes, original check-in photo bytes, actual attendance/snapshots, dated history and same-key/same-payload replay for an unexpired receipt. Compare hashes/counts against the backup and confirm a replay creates no extra record/file association. Stop/restart each process independently and repeat content checks. Reopen admission only after these checks; retained receipts expire by wall-clock time even while backed up.

No attendance/evidence deletion or archival policy is introduced. Schedule events are append-only; recorded attendance snapshots survive calendar changes. Receipt expiry does not authorize evidence deletion. Disk/database/history growth requires monitoring and an explicit future retention decision; do not truncate production history. Deleting initial test rows in a disposable rehearsal is not a production maintenance procedure.

For uncertain staged files, first quiesce both writers and establish SQL rollback/commit and reference state with operator access. Preserve the original key/input. Use original-key replay or the actor-scoped internal `attendance.v1.command-outcome` contract to identify a committed result while its receipt is retained; it is not a public HTTP endpoint. UNKNOWN/missing rows, expired receipts, a timeout or file age cannot establish non-use. Inspect file_objects, employees.photo_file_id and attendances.photo_file_id associations under the stopped-writer boundary, confirm the exact generated object key/digest, and check retained receipts/backups before deciding an individual candidate is proven unused. Keep every unresolved candidate. Only an operator with positive evidence of non-use may remove that exact file; there is no bulk orphan-age deletion command. Restore referenced missing/corrupt content from a matching backup. No upload registry, automatic recovery, audit/revocation or time-off policy is added.

### Operations rehearsal

Build first, then run `npm run test:integration -- --watchman=false --runTestsByPath test/operations.integration-spec.ts` with the isolated test environment described above. The suite refuses any nonempty application table, backs up the empty baseline, and restores it on teardown; never point it at production. Provide MYSQL_BIN/MYSQLDUMP_BIN pointing to native **MySQL 8.4** clients if they are not on PATH. The dedicated test account must be able to dump/restore its schema and create/drop a test trigger. Standard integration tests remain separate from migration/startup behavior.

This rehearsal exercises production `dist` entry points/CLI, concurrent provisioning and rollback, explicit development seeding, attendance outage/restart, real image serving, coordinated SQL+disk restore and replay, bounded cleanup, occupied TCP port, unavailable DB on startup, invalid settings/disk and safe logs. It is not a power-loss/fsync or physical disk-full test; real production identity, supervision, proxy behavior and live DB outage recovery still need deployment rehearsal. Task 020 stays pending until its required native MySQL/TCP checks are actually executed successfully; the task note records current evidence.
