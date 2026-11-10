# WFH Attendance System

## Overview

A work-from-home attendance application where employees record photo-backed check-ins and check-outs, and HR manages work schedules, holidays, and attendance monitoring. This backend runs a NestJS HTTP gateway and a separate attendance microservice connected over TCP.

## Architecture

```mermaid
flowchart LR
    React[React] --> Gateway[NestJS API Gateway]
    Gateway -->|TCP| Attendance[NestJS Attendance Microservice]
    Gateway -->|Authentication, employees, organization| MySQL[(MySQL)]
    Attendance -->|Attendance, schedules, holidays| MySQL
```

## Key Engineering Highlights

### 1. Photo-backed check-in and check-out events

Check-in and check-out include private photo evidence and use server time. HR controls how many minutes before the shift employees can check in. Check-outs before the planned end are marked early; later check-outs remain attached to the original shift until the next scheduled shift's check-in window opens, skipping holidays and non-working days.

At that cutoff, an unclosed record becomes a missed check-out without inventing a departure time or duration. When the employee checks in for the next eligible shift, marking the old record as missed and creating the new attendance happen in one transaction, so a failed check-in cannot leave a partial transition.

### 2. Timezone-aware work shifts

Shift times use IANA timezones and are resolved into UTC instants for comparison with server time. An overnight shift, such as 20:00–04:00, keeps the work date on which it starts, including check-outs after midnight. Working days and holidays determine shift eligibility in the configured timezone.

### 3. Versioned work schedules

HR changes create effective-dated schedule versions. Each save checks `expectedVersion` under a database lock and commits the new schedule and version together, so a stale HR edit receives a conflict instead of overwriting another change.

At check-in, attendance stores the schedule version, timezone, planned start/end, and early check-in allowance as a snapshot. Later schedule edits preserve these recorded shift values. The missed check-out cutoff is calculated from the next scheduled shift under the published calendar.

```mermaid
flowchart LR
    Edit[HR schedule change] --> Check{Version matches?}
    Check -->|No| Conflict[Reject stale edit]
    Check -->|Yes| Version[Save effective-dated version]
    Version --> Resolve[Resolve schedule for work date]
    Resolve --> Snapshot[Snapshot shift at check-in]
    Snapshot --> History[Preserve recorded shift in history]
```

### 4. Idempotent attendance submissions

Each submission carries an idempotency key and a fingerprint of its input, including photo content. The attendance write and its successful response receipt commit in the same database transaction. If the response is lost, retrying the same key and input returns the stored result without creating another attendance record; reusing the key with changed input is rejected while the receipt is retained.

```mermaid
flowchart TD
    Request[Submission: idempotency key and input fingerprint] --> Lookup{Retained receipt for this key?}
    Lookup -->|No| Commit[Commit attendance and response receipt in one transaction]
    Commit --> Result[Return successful response]
    Lookup -->|Yes| Match{Fingerprint matches?}
    Match -->|Yes| Replay[Replay stored response without another attendance write]
    Match -->|No| Reject[Reject changed input: IDEMPOTENCY_KEY_REUSED]
    Result -. Lost response: retry same key and input .-> Request
```

## Quick Start

For Linux production hosting, [compose.yaml](compose.yaml) runs the gateway, TCP attendance service, and MySQL 8.4 separately from any existing server MariaDB installation.

Requires Node.js **26.13.x**, npm **11.20.x**, and MySQL **8.4**. Create an empty database and a database user, with MySQL configured for UTC. Run these commands from `api-server/`:

```sh
npm ci
cp .env.example .env
mkdir -p ../.local/absensi-wfh/files
chmod 700 ../.local/absensi-wfh/files
```

Set the database credentials in `.env`, and replace `JWT_SECRET` and `ATTENDANCE_RPC_CREDENTIAL` with separate random secrets of at least 32 bytes. The commands above prepare the default `STORAGE_ROOT`; its parent directories must not be group- or world-writable.

```sh
npm run migration:run
npm run seed
```

Start the attendance microservice:

```sh
npm run start:attendance
```

In a second terminal, start the HTTP gateway:

```sh
npm run start:prod
```

The demo seed creates **4 HR accounts, 36 employees, and 6 divisions** in development or test environments:

| Role     | Email                          | Password              |
| -------- | ------------------------------ | --------------------- |
| HR       | `demo.hr01@example.test`       | `Demo-Password-12345` |
| Employee | `demo.employee01@example.test` | `Demo-Password-12345` |

Passwords require **8–128 Unicode characters**, including when changing your password.

Setting `SEED_PASSWORD` overrides the default password for newly seeded accounts. Re-running the seeder preserves existing accounts and passwords.

## Database Structure

The diagrams show all 11 application tables and their main columns, using database column names. Routine timestamps and some supporting columns are omitted for readability. `PK` means primary key, `FK` foreign key, and `UK` unique key; nullable columns are noted in comments. HR and employees share the `employees` table, distinguished by `role`.

### Accounts, attendance, files, and retry receipts

```mermaid
erDiagram
    divisions ||--o{ positions : contains
    divisions ||--o{ employees : groups
    positions ||--o{ employees : assigns
    employees ||--o{ attendances : records
    employees ||--o{ file_objects : owns
    file_objects o|--o{ employees : profile_photo
    file_objects ||--o{ attendances : check_in_photo
    employees ||--o{ idempotency_operations : submits
    schedule_versions ||--o{ attendances : snapshots

    divisions {
        char(36) id PK
        varchar(40) code UK
        varchar(160) name
        varchar(2000) description "nullable"
        enum status
        int version
    }
    positions {
        char(36) id PK
        char(36) division_id FK
        varchar(40) code UK
        varchar(160) name
        enum status
        int version
    }
    employees {
        char(36) id PK
        char(36) division_id FK
        char(36) position_id FK
        char(36) photo_file_id FK "nullable"
        varchar(160) full_name
        varchar(254) email UK
        enum role "HRD or EMPLOYEE"
        enum status
        varchar(255) password_hash "nullable"
        boolean has_password_changed
        int version
    }
    attendances {
        char(36) id PK
        char(36) employee_id FK
        char(36) schedule_version_id FK
        char(36) photo_file_id FK
        date work_date
        varchar(100) time_zone
        datetime planned_start_at
        datetime planned_end_at
        smallint opens_minutes_before_start
        datetime check_in_at
        datetime check_out_at "nullable"
        boolean missed_check_out
        enum punctuality "ON_TIME or LATE at check-in"
        int late_seconds
        int duration_seconds "nullable"
        char(36) open_employee_id UK "generated, nullable"
        int version
    }
    file_objects {
        char(36) id PK
        char(36) owner_employee_id FK
        varchar(512) object_key UK
        varchar(255) file_name
        enum mime_type
        int size_bytes
        varchar(64) sha256
        enum purpose
        enum state
    }
    idempotency_operations {
        char(36) id PK
        char(36) actor_id FK
        varchar(200) route_scope
        char(36) idempotency_key
        varchar(64) fingerprint
        enum state
        smallint http_status "nullable"
        json result "nullable"
        char(36) resource_id "nullable, no foreign key"
        datetime expires_at
    }
    schedule_versions {
        char(36) id PK
    }
```

Database constraints enforce one attendance per `(employee_id, work_date)` and one open attendance per employee through the generated `open_employee_id`. A composite foreign key ensures an employee's position belongs to their division. Retry receipts are unique by `(actor_id, route_scope, idempotency_key)`. The idempotency table has one foreign key: `actor_id` references `employees.id`, identifying who submitted the operation. Its `resource_id` is an optional operation-specific reference without a foreign key, so there is no direct relationship to `attendances`. `file_objects` stores metadata; image bytes live in private filesystem storage.

### Versioned schedules and holidays

```mermaid
erDiagram
    employees ||--o{ schedule_versions : creates
    employees ||--o{ schedule_events : performs
    schedule_versions ||--o{ schedule_events : logs
    holiday_calendars ||--o{ holidays : contains

    employees {
        char(36) id PK
    }
    calendar_state {
        tinyint id PK "singleton coordination row"
        int version
    }
    schedule_versions {
        char(36) id PK
        char(36) created_by FK
        json working_days
        varchar(5) start_time
        varchar(5) end_time
        tinyint end_day_offset
        varchar(100) time_zone
        smallint opens_minutes_before_start
        date effective_from
        datetime effective_at
        datetime superseded_at "nullable"
    }
    schedule_events {
        char(36) id PK
        char(36) schedule_version_id FK
        char(36) actor_id FK
        enum kind "SAVED or SUPERSEDED"
        int calendar_version
        json details
    }
    holiday_calendars {
        smallint year PK
        int version
    }
    holidays {
        smallint year PK, FK
        date date PK
        varchar(160) name
        enum category
    }
```

`calendar_state` coordinates calendar changes through a shared lock and version; it has no foreign key relationship to schedule rows. Holidays use the composite primary key `(year, date)`. Attendance references a schedule version and also copies its shift values, preserving the recorded shift after HR changes the schedule.

## Running integration tests

Use the pinned Node version (`nvm use`) and build before testing, since the operations suite launches the compiled entry points:

```sh
nvm use
npm run build
npm run test:integration
```

The command loads `.env.test.local`. Set `NODE_ENV=test`, use an empty dedicated database whose name ends in `_test`, and supply the database credentials and JWT/RPC secrets. Do not seed this database. The suite starts its own gateway and attendance processes.

MySQL must default to UTC (`@@session.time_zone = '+00:00'`). Configure `default-time-zone = '+00:00'` under `[mysqld]` in your MySQL configuration and restart MySQL. For the current server, an administrator can run `SET GLOBAL time_zone = '+00:00';`; this applies to new connections until restart.
