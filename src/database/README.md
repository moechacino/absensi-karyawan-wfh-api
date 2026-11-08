# Database foundation

Task 003 uses the official TypeORM CLI and MySQL 8.4. The current baseline is `InitialSchema1794096000001`: **11 application tables, 15 CHECKs, two schedule-history triggers, one generated open-attendance key**.

| Area | Tables |
| --- | --- |
| Organization | divisions, positions |
| Employees | employees (including hidden credential fields) |
| Images | file_objects |
| Calendar | calendar_state, schedule_versions, schedule_events, holiday_calendars, holidays |
| Attendance | attendances |
| Reliability | idempotency_operations |

TypeORM also owns schema_migrations and typeorm_metadata. There are no time-off/accounting, audit, code-counter, preview-token, HR-guard, JWT-revocation, upload-tracking or deletion-job tables.

## Standard migration workflow

Use the API root and its validated `.env`; explicit process variables take precedence. The migration CLI opens only SQL, creates no accounts/files, and uses the exported DataSource at `dist/database/cli-data-source.js`.

```sh
npm run migration:show
npm run migration:run
```

For a schema change, apply existing migrations to a dedicated development database, update entities, then generate:

```sh
npm run migration:generate -- src/database/migrations/DescribeChange --pretty
```

Review up/down SQL. CHECKs/triggers/data changes need manual additions. Generated MySQL metadata may embed the generation database name; make it portable using the current database, as in the initial migration. Import/register the new class in the migrations array in database.options.ts. Never edit a migration already applied elsewhere.

```sh
npm run migration:create -- src/database/migrations/CustomChange
npm run migration:revert
```

Generate/show/run/revert build current TypeScript first. The CLI prints SQL/diagnostics: migrations must never embed credentials or JWT secrets. Use one operator/serialized deployment job; the standard CLI has no cross-process migration lock. A one-connection pool is supported. Show may create its history table on a fresh database. API startup checks connectivity only and never creates/checks application schema. Run migration:show and reviewed migration:run before starting the API. Pending/unknown migration versions do not automatically block startup.

## Data rules

UUIDs use CHAR(36)/ascii_bin. Instants use UTC DATETIME(3); dates use DATE/string. Employee email has one utf8mb4_bin unique column, normalized by its TypeORM transformer for writes/lookup (trim/lowercase); a CHECK rejects raw unnormalized values. Employee credentials remain mutually exclusive plaintext-initial/hash-personal state on employees. Secret columns use select:false and must be explicitly selected only when necessary; never serialize ORM entities as API responses. No authVersion or employee display code is stored.

Composite employee/position foreign keys enforce compatible divisions. History references restrict deletion. Attendance has employee/date uniqueness and a unique nullable generated open_employee_id. Schedule event UPDATE/DELETE triggers enforce append-only history; no general audit table is required. Use scoped runtime DML privileges: administrators/TRUNCATE can bypass ordinary row triggers. Migration identity needs DDL/REFERENCES/TRIGGER privileges; binary-log configuration may require DBA-approved trigger settings. The CLI never modifies global server settings.

Only calendar_state(id=1,version=0) is seeded. Keep the calendar/version schema. Introduce transaction/lock/expected-version code only alongside the feature that uses it, with its real transaction boundary and lock order. No shared transaction helpers are implemented now; task 005 and owning calendar/attendance tasks will add needed coordination.

JWT configuration is stateless 3600 seconds. Actual auth routes/guards remain task 006: local signature/issuer/audience/subject/expiry validation, client logout, no DB token revocation lookup. Ownership/data queries are separate from authentication.

## Files and failure handling

Image metadata supports only JPEG/PNG/WebP check-in/profile images. Actual upload/content commands remain task 007 and owning feature tasks. A failed file write returns an error and commits no SQL change. Write validated bytes before the database commit; if SQL fails, roll back and attempt direct deletion. Delete replaced profile photos only after commit. SQL rollback cannot undo filesystem changes. Crashes/deletion failures may leave orphan files for manual cleanup; persistent upload/retry jobs are deferred. Do not claim these workflows are implemented by metadata entities alone.

## Rollback and existing databases

MySQL DDL implicitly commits (`migrationsTransactionMode: none`). Partial failures require inspection and explicit repair; rerunning is not proof of recovery. The initial migration refuses nonempty application schemas. Stop all writers before revert: it only allows an untouched empty baseline and rejects used/unexpected table inventories before DDL. Its preflight is not a concurrency lock. No force/reset option is provided.

Earlier unapplied drafts had 26 or 19 tables and different migration versions. If applied elsewhere, preserve their files/data and use a reviewed non-destructive forward migration; never edit history, drop data or apply this initial migration over them merely to defer features. Used databases require verified backup/restore or a reviewed forward repair. Do not fake-mark partial SQL as applied.

## Verification

Use `npm run test:integration` only with a dedicated database ending in `_test`. It explicitly migrates the database, checks empty revert/reapply and refusal on used/earlier schemas, creates fictional rows in rolled-back transactions. Tests verify the inventory, ORM schema alignment, real constraints/triggers, single-column email normalization, hidden credentials, UTC/dates, image restrictions, idempotency uniqueness and standard migration execution. No business endpoint/storage workflow is claimed by this foundation.
