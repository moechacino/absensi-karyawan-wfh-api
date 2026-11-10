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

Setting `SEED_PASSWORD` overrides the default password for newly seeded accounts. Re-running the seeder preserves existing accounts and passwords.
