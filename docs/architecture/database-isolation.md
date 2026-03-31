# PostgreSQL Database Isolation — Three-Layer Boundary

## Overview

Write-protection of drive rules is enforced at three architectural layers:

1. **Structural (TypeScript)**: Service design patterns and dependency injection prevent unauthorized database calls
2. **Process Isolation (IPC)**: The Drive Engine runs in a separate child process with one-way communication only
3. **Database RLS (PostgreSQL)**: Row-level security policies enforce role-based access control at the database level

CANON Immutable Standard 6 (No Self-Modification of Evaluation) is enforced holistically across all three layers.

---

## Layer 3: Database-Level Enforcement

### Architecture

The PostgreSQL system database uses **role-based access control (RLS)** with four distinct roles:

| Role | Purpose | Permissions |
|------|---------|-------------|
| `admin` | Schema initialization and guardian approvals | Full DDL + DML on all tables |
| `sylphie_app` | Runtime application (NestJS process) | SELECT drive_rules + INSERT proposed_drive_rules |
| `drive_engine` | Isolated drive computation process | SELECT-only on both tables |
| `guardian_admin` | Human guardian (dashboard interface) | Full permissions for approvals and rule edits |

### Permission Matrix

#### `drive_rules` Table (Active Rules)

| Operation | `admin` | `sylphie_app` | `drive_engine` | `guardian_admin` |
|-----------|---------|--------------|----------------|-----------------|
| SELECT | ✓ | ✓ | ✓ | ✓ |
| INSERT | ✓ | ✗ | ✗ | ✓ |
| UPDATE | ✓ | ✗ | ✗ | ✓ |
| DELETE | ✓ | ✗ | ✗ | ✓ |

**Key constraint**: The `sylphie_app` runtime user cannot INSERT, UPDATE, or DELETE from `drive_rules`. Even if the application code explicitly attempted these operations, PostgreSQL RLS policies would reject them with "permission denied" errors.

#### `proposed_drive_rules` Table (Review Queue)

| Operation | `admin` | `sylphie_app` | `drive_engine` | `guardian_admin` |
|-----------|---------|--------------|----------------|-----------------|
| SELECT | ✓ | ✓ | ✓ | ✓ |
| INSERT | ✓ | ✓ | ✗ | ✓ |
| UPDATE | ✓ | ✗ | ✗ | ✓ |
| DELETE | ✓ | ✗ | ✗ | ✓ |

**Key constraint**: Only `sylphie_app` and `admin`/`guardian_admin` can INSERT into the proposal queue. The isolated `drive_engine` process can read but never propose. UPDATE and DELETE are restricted to guardians only.

---

## Credential Management

Credentials are sourced **entirely from environment variables**. No passwords are hardcoded.

### Environment Variables

```
POSTGRES_HOST              # Database host (default: localhost)
POSTGRES_PORT              # Database port (default: 5434)
POSTGRES_DB                # Database name (default: sylphie_system)

POSTGRES_ADMIN_USER        # Admin role (for migrations only)
POSTGRES_ADMIN_PASSWORD    # Admin password

POSTGRES_SYLPHIE_APP_USER  # Runtime application role
POSTGRES_SYLPHIE_APP_PASSWORD

POSTGRES_DRIVE_ENGINE_USER # Isolated drive process role
POSTGRES_DRIVE_ENGINE_PASSWORD

POSTGRES_GUARDIAN_ADMIN_USER # Human guardian dashboard role
POSTGRES_GUARDIAN_ADMIN_PASSWORD

POSTGRES_MAX_CONNECTIONS   # Pool size (default: 10)
POSTGRES_IDLE_TIMEOUT_MS   # Idle timeout (default: 30000)
POSTGRES_CONNECTION_TIMEOUT_MS # Connection timeout (default: 5000)
```

### Configuration Structure

The application loads credentials via:
1. `src/shared/config/app.config.ts` — reads `process.env` and builds `AppConfig`
2. `src/shared/config/database.config.ts` — type definitions for `PostgresConfig`
3. `src/database/database.module.ts` — creates three connection pools:
   - `POSTGRES_ADMIN_POOL` — used only during schema initialization
   - `POSTGRES_RUNTIME_POOL` — exported for application services
   - (Future) `POSTGRES_DRIVE_ENGINE_POOL` — for the isolated drive process

---

## Migration: 004-drive-engine-rls.sql

The migration script (`src/db/migrations/004-drive-engine-rls.sql`) is **idempotent** and safe to re-execute.

### What It Does

1. **Creates roles** (if not present):
   ```sql
   CREATE ROLE sylphie_app LOGIN;
   CREATE ROLE drive_engine LOGIN;
   CREATE ROLE guardian_admin LOGIN;
   ```

2. **Creates tables** (if not present):
   - `drive_rules` — active evaluation rules
   - `proposed_drive_rules` — rule review queue

3. **Enables RLS** on both tables and creates role-specific policies

4. **Grants permissions** according to the permission matrix above

### Idempotency Guarantees

- Uses `CREATE TABLE IF NOT EXISTS` — safe to re-run
- Uses `DROP POLICY IF EXISTS` before creating policies — safe to re-run
- Uses `DO $$ ... EXCEPTION WHEN DUPLICATE_OBJECT THEN NULL; $$` for role creation — safe to re-run
- All policy changes are reversible (no data loss on re-execution)

---

## RLS Verification Service

The `RlsVerificationService` (`src/drive-engine/postgres-verification/verify-rls.ts`) runs at NestJS module initialization (OnModuleInit hook) and verifies:

### Verification Checks

1. **Cannot UPDATE drive_rules** — `sylphie_app` attempts an UPDATE; RLS must reject it
2. **Cannot DELETE drive_rules** — `sylphie_app` attempts a DELETE; RLS must reject it
3. **CAN SELECT drive_rules** — `sylphie_app` performs a SELECT; must succeed
4. **CAN INSERT proposed_drive_rules** — `sylphie_app` inserts a test row; must succeed

All checks happen in a **rolled-back transaction**. If any check fails, the service logs a CRITICAL error and throws, preventing application startup.

### Startup Behavior

```
[RlsVerificationService] Starting RLS verification...
[RlsVerificationService] Connected to PostgreSQL for RLS verification
[RlsVerificationService] Verified: sylphie_app cannot UPDATE drive_rules
[RlsVerificationService] Verified: sylphie_app cannot DELETE drive_rules
[RlsVerificationService] Verified: sylphie_app CAN SELECT from drive_rules
[RlsVerificationService] Verified: sylphie_app CAN INSERT into proposed_drive_rules
[RlsVerificationService] RLS verification passed - write-protection is active
```

If RLS is broken:
```
[RlsVerificationService] RLS VERIFICATION FAILED: RLS FAILURE: sylphie_app was able to UPDATE drive_rules - write-protection is not enforced - Startup aborted to prevent security bypass
[Error] Application startup failed
```

---

## PostgreSQL Rules Client

The `PostgresRulesClient` (`src/drive-engine/rule-proposer/postgres-rules-client.ts`) provides type-safe access to drive rules:

### Methods

```typescript
// Get all enabled active rules
async getActiveRules(): Promise<DriveRule[]>

// Submit a proposal for guardian review
async insertProposedRule(rule: ProposedRuleInput): Promise<void>
```

### Usage Example

```typescript
// Inject the client
constructor(private readonly rulesClient: PostgresRulesClient) {}

// Propose a new rule
await this.rulesClient.insertProposedRule({
  triggerPattern: 'SUCCESSFUL_PREDICTION',
  effect: JSON.stringify({ satisfaction: +0.1 }),
  confidence: 0.5,
  proposedBy: 'SYSTEM',
  reasoning: 'Predictions are getting more accurate; reward learning.',
});
```

---

## RuleProposerService

The `RuleProposerService` implements the `IRuleProposer` interface and converts high-level rule proposals to database INSERT operations.

### CANON Constraint

The only path for autonomous system rule proposals is:
1. System detects a pattern → calls `proposeRule()`
2. Rule inserted into `proposed_drive_rules` with status='pending'
3. Rule enters guardian review queue
4. Guardian approves via dashboard → row copied to `drive_rules` by guardian tooling
5. Active rule takes effect

The system **never directly modifies `drive_rules`**. RLS guarantees this at the database layer.

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ NestJS Application (sylphie_app role)                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  RuleProposerService                                        │
│  └─ calls PostgresRulesClient.insertProposedRule()          │
│     └─ INSERT INTO proposed_drive_rules VALUES (...)        │
│        └─ RLS ALLOWS (sylphie_app can INSERT)               │
│                                                              │
│  Other services                                             │
│  └─ call PostgresRulesClient.getActiveRules()              │
│     └─ SELECT * FROM drive_rules WHERE enabled=true        │
│        └─ RLS ALLOWS (sylphie_app can SELECT)               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ PostgreSQL RLS Enforcement                                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  drive_rules (write-protected)                              │
│  ├─ SELECT: OK (policy allows sylphie_app)                  │
│  ├─ INSERT: DENIED (no policy for INSERT)                   │
│  ├─ UPDATE: DENIED (no policy for UPDATE)                   │
│  └─ DELETE: DENIED (explicitly revoked)                     │
│                                                              │
│  proposed_drive_rules (review queue)                        │
│  ├─ SELECT: OK (policy allows sylphie_app)                  │
│  └─ INSERT: OK (policy allows sylphie_app)                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Future: Drive Engine Process Integration

Phase 2 will add a fourth credential pair:
- `POSTGRES_DRIVE_ENGINE_USER` / `POSTGRES_DRIVE_ENGINE_PASSWORD`
- Used by the isolated drive computation child process
- RLS policies restrict this role to SELECT-only on both tables
- No proposal capability (preserves the one-way IPC boundary)

---

## Testing & Validation

### Manual Verification

```bash
# Connect as sylphie_app and verify permissions
psql -h localhost -p 5434 -U sylphie_app -d sylphie_system

# This should work:
SELECT COUNT(*) FROM drive_rules;

# This should fail with "permission denied":
UPDATE drive_rules SET enabled = false;
DELETE FROM drive_rules;

# This should work:
INSERT INTO proposed_drive_rules (trigger_pattern, effect, confidence, proposed_by)
VALUES ('TEST', 'TEST', 0.5, 'SYSTEM');
```

### Application Startup

The `RlsVerificationService` automatically runs these tests on NestJS module init. If startup succeeds, RLS enforcement is active.

---

## References

- **CANON**: `wiki/CANON.md` Section 6 (No Self-Modification)
- **Architecture Diagram**: `wiki/sylphie2.png` (shows database layer)
- **Migration Script**: `src/db/migrations/004-drive-engine-rls.sql`
- **RLS Verification**: `src/drive-engine/postgres-verification/verify-rls.ts`
- **Rules Client**: `src/drive-engine/rule-proposer/postgres-rules-client.ts`
- **Rule Proposer**: `src/drive-engine/rule-proposer.service.ts`
