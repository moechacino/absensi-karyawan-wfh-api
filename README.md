# Absensi Karyawan WFH API

NestJS runtime foundation using Express, MySQL, TypeORM, and private local storage. Business routes, authentication flows, migrations, and file-content delivery are implemented in later tasks. This task starts the application and checks its dependencies; `/` returns 404 and no account is created on startup.

The shared API source is [contracts](../contracts/README.md). Work and review status live in [the task index](../api-server-tasks/index.md); the selected architecture is in [the technical design](../api-server-tasks/api-server.technical.md).

## Runtime and dependencies

Use **Node 26.13.0** (`.nvmrc`) and **npm 11.20.0**. Direct dependency versions are exact and the lockfile is committed with approved changes. The engine check prevents accidentally installing with another Node major. No global Node installation is changed by this project.

```sh
nvm install
nvm use
npm ci
```

The selected stack is NestJS 12.3.3, `@nestjs/typeorm` 12.0.3, TypeORM 1.1.2, `mysql2` 3.24.6, MySQL 8.4.6 LTS, TypeScript 6.0.3, Jest 30.5.2, and ts-jest 29.4.15. The real-MySQL integration suite verifies this combination rather than relying only on declared peer compatibility. TypeORM 1.x uses mysql2 directly; its removed `connectorPackage` option is not used.

JWT/class-validator/class-transformer/Argon2 dependencies are installed for the subsequent modules. npm 11 install-script approvals are pinned for Argon2 and the Nest CLI watcher so clean installs reproduce their native setup. Configured JWT key format is an HS256 secret of at least 32 bytes; the signature test does not implement login or establish the production key-rotation policy. Browser allowlists are validated independently but their HTTP CORS/CSRF wiring belongs to task 004.

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
npm run start:dev
```

## Environment settings

| Settings | Behavior |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production`; defaults to development |
| `HOST`, `PORT` | Bind IP/localhost and port; defaults to `127.0.0.1:3000` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` | Required connection identity/secret; port defaults to 3306; database name uses letters/digits/underscores |
| `DB_POOL_SIZE`, `DB_CONNECT_TIMEOUT_MS` | Defaults to 10 connections and a 10-second connection timeout |
| `JWT_ALGORITHM`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | HS256 only in this foundation; real non-placeholder secret required; issuer/audience required |
| `JWT_ACCESS_TTL_SECONDS` | Default 28800 (8 hours), the accepted planning baseline |
| `CORS_ORIGINS`, `CSRF_TRUSTED_ORIGINS` | Separate comma-delimited origin allowlists; no wildcard/path/credential/query; HTTPS only in production; empty means no cross-origin trust |
| `STORAGE_ROOT` | Required private directory outside the application directory; relative paths resolve from `api-server/`; created with mode 0700 if absent and checked for read/write/traversal access |
| `MAX_FILE_BYTES`, `MAX_CONCURRENT_UPLOADS` | Defaults to 5 MiB and four uploads; bytes cannot exceed the contract's 5 MiB ceiling; upload enforcement comes with the HTTP/storage tasks |
| `BUSINESS_TOKEN_TTL_SECONDS` | Default/max 600 seconds; token implementation comes in task 005 |
| `IDEMPOTENCY_RETENTION_SECONDS` | Default/minimum 86400 seconds; operation retention implementation comes in task 005 |

Password policy defaults are 15–128 characters. Environment policy changes must be reflected in the shared contract and published policy before release. Config validation reports setting names and constraints, never rejected values. Database/storage startup errors are sanitized; use a MySQL client and local operational logs to diagnose the actual service, rather than enabling SQL/credential logging.

Local evidence belongs on a persistent private disk, outside public/source directories. The example uses `../.local/absensi-wfh/files`. Keep that directory out of source control and PWA/static hosting. Production disk topology, backup/retention, TLS/proxy configuration, and scale are separate operational decisions.

## Build and run

```sh
npm run build
npm run start:prod
```

The build emits `dist/main.js`; production start executes that file. Startup validates configuration, connects to MySQL without retrying indefinitely, checks/creates the private root, and then listens. Shutdown hooks close Nest and its connection pool. Invalid configuration or an unavailable dependency fails before a successful listen; startup never runs schema synchronization, migrations, registration, or account seeds.

Schema migrations and their CLI scripts are task 003. No migration command is available in the runtime foundation. `synchronize` and `migrationsRun` are explicitly false in every environment; do not work around the missing schema with automatic synchronization.

## Verification

```sh
npm run lint
npm test -- --runInBand
npm run test:e2e -- --runInBand
```

Unit tests check parsing, safe origin/secret handling, policy bounds, and redacted validation failures. E2e tests replace only the database provider, use an isolated temporary storage directory and injectable clock, and check that no business/bootstrap route exists. They do not establish MySQL compatibility.

For the explicit integration suite, prepare a **dedicated empty MySQL 8.4 database** and put its `DB_*` settings, a test-only JWT secret/issuer/audience, and a private `STORAGE_ROOT` in ignored `.env.test.local`, with `NODE_ENV=test`. This suite never implicitly uses `.env`. It creates a connection-local temporary table, checks rollback/commit and UTC/date-only values, starts the actual Nest application, and verifies JWT plus native Argon2id imports. It does not create an employee or a business table.

```sh
npm run test:integration
```

The integration runner loads `.env.test.local` if present; CI can supply equivalent process environment variables instead. Do not point it at a production or populated business database. Task 002 verification used an isolated native MySQL 8.4.6 instance and direct Node processes; test data and temporary credentials were removed afterward.

Shared contract validation uses the separate Python environment described in [contracts/README.md](../contracts/README.md). Runtime foundation tests do not claim the 50 business operations are implemented.

## Dependency audit notes

The unused starter `@nestjs/mau` deployment dependency and its placeholder deploy command were removed, eliminating the observed high-severity findings in that toolchain. Nest CLI was updated to 12.0.12. The current production dependency audit reports zero advisories. The full audit still reports 20 development-tool findings (4 low, 16 moderate), principally in Jest transitive glob/minimatch/deepmerge dependencies; the registry currently suggests incompatible downgrades rather than a compatible patched Jest release. No forced downgrades or unverified major dependency overrides were applied. Review compatible fixes when upstream releases them; do not use the test toolchain with untrusted input.
