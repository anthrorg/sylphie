# Epic 1: Database Infrastructure -- Forge Architectural Analysis

**Status:** Planning
**Epic Scope:** All 5 database connections wired, schemas created, stubs replaced with real implementations
**Analysis Date:** 2026-03-29
**Scope:** NestJS/TypeScript architecture, module boundaries, DI patterns, configuration

---

## Executive Summary

Epic 1 replaces all five database stub interfaces with real connections and schema initialization. This is the second-most critical epic (after E0's interface skeleton) because everything else depends on having reliable, correctly-isolated access to Neo4j, TimescaleDB, PostgreSQL, and Grafeo.

The key architectural challenge is **isolation without complexity**: each database must be accessible from the subsystems that need it, but the module structure must enforce that:
- Only KnowledgeModule owns Neo4j and Grafeo
- Only EventsModule owns TimescaleDB
- Only SharedModule owns PostgreSQL (for system metadata)
- Drive Engine reads drive rules from Postgres but never writes to the evaluation function
- No module smuggles database calls through unintended channels

This analysis covers module ownership, provider patterns, initialization order, configuration schema, error handling, and ticket sequencing.

---

## 1. Module Wiring Plan

### 1.1 Database Ownership Matrix

| Database | Purpose | Owner Module | Read Access | Write Access | Init Order |
|----------|---------|--------------|-------------|--------------|------------|
| Neo4j | World Knowledge Graph | KnowledgeModule | All subsystems (via WKG_SERVICE) | KnowledgeModule only | 2 |
| TimescaleDB | Event backbone | EventsModule | All subsystems (via EVENTS_SERVICE) | EventsModule, Decision, Communication, Learning, Drive | 2 |
| PostgreSQL (System DB) | Drive rules, settings, users | SharedModule (DatabaseModule) | DriveEngineModule (rules), others (settings) | Admin pool: DBAdmin, Guardian mutations; Runtime pool: DriveEngine proposals | 1 |
| Grafeo (Self KG) | Self-model | KnowledgeModule | Decision, Learning, Drive Engine | Learning, Drive Engine | 2 |
| Grafeo (Other KGs) | Person models | KnowledgeModule | All subsystems | Communication, Learning (per-person) | 2 |

### 1.2 Module Dependency Graph

```
AppModule
├── ConfigModule (global, async validation)
├── DatabaseModule (admin pool, no exports)
├── SharedModule (exceptions, types, constants)
├── KnowledgeModule
│   ├── depends on: ConfigService
│   ├── provides: WKG_SERVICE, SELF_KG_SERVICE, OTHER_KG_SERVICE
│   ├── OnModuleInit: Neo4j constraints, Grafeo schema
│   └── OnModuleDestroy: Neo4j driver close
├── EventsModule
│   ├── depends on: ConfigService
│   ├── provides: EVENTS_SERVICE (TimescaleDB)
│   ├── OnModuleInit: Hypertable creation, compression policies
│   └── OnModuleDestroy: pg pool drain
├── DecisionMakingModule
│   ├── depends on: KnowledgeModule, EventsModule, DriveEngineModule (read-only)
│   └── provides: DecisionMakingService
├── CommunicationModule
│   ├── depends on: KnowledgeModule, EventsModule, DriveEngineModule (read-only)
│   └── provides: CommunicationService
├── LearningModule
│   ├── depends on: KnowledgeModule, EventsModule, DriveEngineModule (read-only)
│   └── provides: LearningService
├── DriveEngineModule
│   ├── depends on: ConfigService, EventsModule (read-only), PostgreSQL runtime pool
│   ├── provides: DRIVE_STATE_READER (read-only for others)
│   └── note: Drive process isolation via separate process or strict module boundary
└── PlanningModule
    ├── depends on: KnowledgeModule, EventsModule, DriveEngineModule (read-only)
    └── provides: PlanningService
```

**Initialization Order Critical Constraint:**
1. ConfigModule must load and validate first (globally)
2. DatabaseModule + KnowledgeModule + EventsModule must initialize in parallel (no cross-dependencies)
3. All subsystem modules (DecisionMaking, Communication, etc.) initialize after infrastructure is ready

NestJS provides `async ModuleRef` in the root module to enforce initialization order if needed, but careful module declaration order usually suffices.

### 1.3 Database Provider Locations

Each database connection is a **factory provider** declared in its owner module, making initialization async and explicit:

#### Neo4j Driver (KnowledgeModule)

```typescript
// src/knowledge/knowledge.providers.ts
export const NEO4J_DRIVER = Symbol('NEO4J_DRIVER');

export const neo4jDriverProvider: FactoryProvider<Driver> = {
  provide: NEO4J_DRIVER,
  useFactory: async (
    configService: ConfigService<AppConfig>,
    logger: Logger,
  ): Promise<Driver> => {
    const neo4jConfig = configService.get('neo4j', { infer: true });
    const driver = neo4j.driver(
      neo4jConfig.uri,
      neo4j.auth.basic(neo4jConfig.username, neo4jConfig.password),
      {
        maxConnectionPoolSize: neo4jConfig.maxConnectionPoolSize || 50,
        logging: logger.debug.bind(logger),
      },
    );
    try {
      await driver.verifyConnectivity();
      logger.log('Neo4j driver connected and verified');
    } catch (error) {
      logger.error('Neo4j connectivity check failed', error);
      throw error;
    }
    return driver;
  },
  inject: [ConfigService, Logger],
};
```

#### TimescaleDB Connection (EventsModule)

```typescript
// src/events/events.providers.ts
export const TIMESCALE_POOL = Symbol('TIMESCALE_POOL');

export const timescalePoolProvider: FactoryProvider<Pool> = {
  provide: TIMESCALE_POOL,
  useFactory: async (
    configService: ConfigService<AppConfig>,
    logger: Logger,
  ): Promise<Pool> => {
    const tsConfig = configService.get('timescale', { infer: true });
    const pool = new Pool({
      host: tsConfig.host,
      port: tsConfig.port,
      database: tsConfig.database,
      user: tsConfig.username,
      password: tsConfig.password,
      max: tsConfig.maxConnections || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
    });

    try {
      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      logger.log('TimescaleDB pool connected and verified');
    } catch (error) {
      logger.error('TimescaleDB connectivity check failed', error);
      throw error;
    }

    return pool;
  },
  inject: [ConfigService, Logger],
};
```

#### PostgreSQL Pools (SharedModule / DatabaseModule)

```typescript
// src/shared/database/database.providers.ts
export const PG_ADMIN_POOL = Symbol('PG_ADMIN_POOL');
export const PG_RUNTIME_POOL = Symbol('PG_RUNTIME_POOL');

export const pgAdminPoolProvider: FactoryProvider<Pool> = {
  provide: PG_ADMIN_POOL,
  useFactory: async (
    configService: ConfigService<AppConfig>,
    logger: Logger,
  ): Promise<Pool> => {
    const pgConfig = configService.get('postgres', { infer: true });
    const adminPool = new Pool({
      host: pgConfig.host,
      port: pgConfig.port,
      database: pgConfig.database,
      user: pgConfig.adminUsername,  // Different user role
      password: pgConfig.adminPassword,
      max: 5,  // Admin pool is small
      idleTimeoutMillis: 30000,
    });

    try {
      const client = await adminPool.connect();
      await client.query('SELECT NOW()');
      client.release();
      logger.log('PostgreSQL admin pool connected and verified');
    } catch (error) {
      logger.error('PostgreSQL admin pool connectivity check failed', error);
      throw error;
    }

    return adminPool;
  },
  inject: [ConfigService, Logger],
};

export const pgRuntimePoolProvider: FactoryProvider<Pool> = {
  provide: PG_RUNTIME_POOL,
  useFactory: async (
    configService: ConfigService<AppConfig>,
    logger: Logger,
  ): Promise<Pool> => {
    const pgConfig = configService.get('postgres', { infer: true });
    const runtimePool = new Pool({
      host: pgConfig.host,
      port: pgConfig.port,
      database: pgConfig.database,
      user: pgConfig.runtimeUsername,  // Different user role (lower privileges)
      password: pgConfig.runtimePassword,
      max: pgConfig.maxConnections || 20,
      idleTimeoutMillis: 30000,
    });

    try {
      const client = await runtimePool.connect();
      await client.query('SELECT NOW()');
      client.release();
      logger.log('PostgreSQL runtime pool connected and verified');
    } catch (error) {
      logger.error('PostgreSQL runtime pool connectivity check failed', error);
      throw error;
    }

    return runtimePool;
  },
  inject: [ConfigService, Logger],
};
```

**Key Note on Admin Pool:** The admin pool is provided in DatabaseModule and **NOT exported**. Only DatabaseModule itself can request it via constructor injection. This forces any admin operation through an explicit service interface that the rest of the system cannot invoke directly.

#### Grafeo Self KG (KnowledgeModule)

```typescript
// src/knowledge/grafeo/self-kg.provider.ts
export const SELF_KG_SERVICE = Symbol('SELF_KG_SERVICE');

export const selfKgProvider: FactoryProvider<IGrafeoCoreKG> = {
  provide: SELF_KG_SERVICE,
  useFactory: async (
    configService: ConfigService<AppConfig>,
    logger: Logger,
  ): Promise<IGrafeoCoreKG> => {
    const grafeoDirConfig = configService.get('grafeo', { infer: true });
    const selfKgPath = path.join(grafeoDirConfig.basePath, 'self-kg');

    // Ensure directory exists
    await fs.promises.mkdir(selfKgPath, { recursive: true });

    const selfKg = new GrafeoCoreKG(selfKgPath, {
      pageSize: 4096,
      enableCompression: true,
    });

    await selfKg.initialize();
    logger.log(`Grafeo Self KG initialized at ${selfKgPath}`);

    return selfKg;
  },
  inject: [ConfigService, Logger],
};
```

#### Grafeo Other KGs (KnowledgeModule)

Per-person Grafeo instances are created on-demand, not during module init:

```typescript
// src/knowledge/grafeo/other-kg.service.ts
@Injectable()
export class OtherKgService {
  private readonly kgCache = new Map<string, IGrafeoCoreKG>();

  constructor(
    private readonly configService: ConfigService<AppConfig>,
    private readonly logger: Logger,
  ) {}

  async getOrCreateKg(personId: string): Promise<IGrafeoCoreKG> {
    if (this.kgCache.has(personId)) {
      return this.kgCache.get(personId)!;
    }

    const grafeoDirConfig = this.configService.get('grafeo', { infer: true });
    const kgPath = path.join(grafeoDirConfig.basePath, `person-${personId}`);

    await fs.promises.mkdir(kgPath, { recursive: true });

    const kg = new GrafeoCoreKG(kgPath, {
      pageSize: 4096,
      enableCompression: true,
    });

    await kg.initialize();
    this.logger.log(`Grafeo KG created for person: ${personId}`);
    this.kgCache.set(personId, kg);

    return kg;
  }
}
```

This service is a wrapper around Grafeo's direct instantiation. It is provided by KnowledgeModule and used by Communication and Learning subsystems.

---

## 2. Provider Design Patterns

### 2.1 Async Factory Provider Pattern

All database connections must initialize asynchronously. NestJS factory providers support this:

```typescript
{
  provide: SOME_SERVICE,
  useFactory: async (...deps) => {
    // Async initialization here
    const resource = await initializeResource();
    return resource;
  },
  inject: [Dep1, Dep2],
}
```

**Critical:** Mark the provider as async in your module imports if using async initialization. NestJS handles this automatically if all providers are properly declared.

### 2.2 OnModuleInit / OnModuleDestroy Lifecycle

Each module that owns a database connection must implement cleanup:

```typescript
@Module({
  providers: [neo4jDriverProvider, wkgService],
  exports: [WKG_SERVICE],
})
export class KnowledgeModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(NEO4J_DRIVER) private readonly driver: Driver,
    private readonly logger: Logger,
  ) {}

  async onModuleInit() {
    // Neo4j constraint setup
    const session = this.driver.session();
    try {
      // Create constraints (idempotent)
      await session.run(`
        CREATE CONSTRAINT node_label_id IF NOT EXISTS
        FOR (n:Node) REQUIRE n.id IS UNIQUE
      `);
      await session.run(`
        CREATE CONSTRAINT edge_id_unique IF NOT EXISTS
        FOR (e:RELATIONSHIP) REQUIRE e.id IS UNIQUE
      `);
      this.logger.log('Neo4j schema constraints initialized');
    } finally {
      await session.close();
    }
  }

  async onModuleDestroy() {
    this.logger.log('Closing Neo4j driver...');
    await this.driver.close();
  }
}
```

### 2.3 Health Check Integration

NestJS provides a `@nestjs/terminus` package for composable health checks:

```typescript
// src/shared/health/database.health.ts
@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(NEO4J_DRIVER) private readonly neo4jDriver: Driver,
    @Inject(TIMESCALE_POOL) private readonly tsPool: Pool,
    @Inject(PG_RUNTIME_POOL) private readonly pgPool: Pool,
  ) {
    super();
  }

  async checkNeo4j(): Promise<HealthIndicatorResult> {
    try {
      const session = this.neo4jDriver.session();
      await session.run('RETURN 1');
      await session.close();
      return this.getStatus('neo4j', true);
    } catch (error) {
      return this.getStatus('neo4j', false, { error: error.message });
    }
  }

  async checkTimescale(): Promise<HealthIndicatorResult> {
    try {
      const client = await this.tsPool.connect();
      await client.query('SELECT NOW()');
      client.release();
      return this.getStatus('timescale', true);
    } catch (error) {
      return this.getStatus('timescale', false, { error: error.message });
    }
  }

  async checkPostgres(): Promise<HealthIndicatorResult> {
    try {
      const client = await this.pgPool.connect();
      await client.query('SELECT NOW()');
      client.release();
      return this.getStatus('postgres', true);
    } catch (error) {
      return this.getStatus('postgres', false, { error: error.message });
    }
  }
}

// src/shared/health/health.controller.ts
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService,
              private readonly dbHealth: DatabaseHealthIndicator) {}

  @Get()
  async check() {
    return this.health.check([
      () => this.dbHealth.checkNeo4j(),
      () => this.dbHealth.checkTimescale(),
      () => this.dbHealth.checkPostgres(),
    ]);
  }
}
```

Mount this in a HealthModule and expose it on a public endpoint. Helm/k8s probes will use this for readiness/liveness checks.

### 2.4 Transaction Wrapper Pattern (TimescaleDB)

Event writes often need transactions. Provide a helper:

```typescript
// src/events/events.transaction.ts
@Injectable()
export class EventsTransaction {
  constructor(
    @Inject(TIMESCALE_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Execute a callback within a transaction. Commit on success, rollback on error.
   */
  async run<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
```

---

## 3. New Modules / Services

### 3.1 DatabaseModule (Shared)

**Purpose:** Owns PostgreSQL (both pools) and provides admin-only services. Not imported by subsystems directly; used internally by SharedModule and DriveEngineModule.

**Structure:**
```
src/shared/database/
├── database.module.ts
├── database.providers.ts        # PG_ADMIN_POOL, PG_RUNTIME_POOL factories
├── database.service.ts          # Wrapper for admin operations (RLS setup, etc.)
├── rls/
│   ├── rls.initializer.ts      # Sets up row-level security rules on init
│   └── rls.types.ts
└── index.ts
```

**Module Declaration:**
```typescript
@Module({
  providers: [
    pgAdminPoolProvider,
    pgRuntimePoolProvider,
    DatabaseService,
    RlsInitializer,
  ],
  // Note: NO exports. Admin pool stays internal.
})
export class DatabaseModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(PG_ADMIN_POOL) private readonly adminPool: Pool,
    private readonly rlsInit: RlsInitializer,
  ) {}

  async onModuleInit() {
    // RLS setup, drive_rules table create, etc.
    await this.rlsInit.setup();
  }

  async onModuleDestroy() {
    await this.adminPool.end();
  }
}
```

**What it exports:**
- Nothing to other modules (DatabaseModule is private to SharedModule)
- Internal to SharedModule, makes admin pool available for one-time setup

### 3.2 KnowledgeModule Updates

Replaces Neo4j stub with real driver + Grafeo instances.

**Structure:**
```
src/knowledge/
├── knowledge.module.ts
├── knowledge.providers.ts
├── knowledge.tokens.ts
├── wkg/
│   ├── wkg.service.ts           # Real Neo4j queries
│   ├── wkg-query.builder.ts     # Cypher query construction
│   └── wkg.exceptions.ts
├── grafeo/
│   ├── self-kg.provider.ts
│   ├── self-kg.service.ts
│   ├── other-kg.service.ts
│   └── grafeo-cache.service.ts
├── interfaces/
│   ├── knowledge.interfaces.ts  # IWkgService, etc.
│   └── grafeo.interfaces.ts
└── index.ts
```

**Exports:**
- `WKG_SERVICE` (Neo4j)
- `SELF_KG_SERVICE` (Grafeo Self)
- `OTHER_KG_SERVICE` (Grafeo Other — wrapped)

### 3.3 EventsModule Updates

Replaces TimescaleDB stub with real pg Pool.

**Structure:**
```
src/events/
├── events.module.ts
├── events.providers.ts
├── events.service.ts            # Real TimescaleDB writes
├── events.transaction.ts         # Transaction helper
├── hypertable-setup.ts          # Schema initialization
├── event.types.ts
├── interfaces/
│   └── events.interfaces.ts
└── index.ts
```

**Exports:**
- `EVENTS_SERVICE` (TimescaleDB via IEventsService)

### 3.4 No New Subsystem Modules

The five subsystems (Decision, Communication, Learning, Drive, Planning) do NOT change. They receive the real database services via DI.

---

## 4. Health Check Architecture

The system needs:

1. **Per-database indicators** (see section 2.2 above)
2. **Application startup readiness check** — does not proceed to subsystem initialization until all databases are healthy
3. **Periodic health monitoring** — background service that checks connection pools every 30 seconds and logs degradation

```typescript
// src/shared/health/health.module.ts
@Module({
  providers: [
    DatabaseHealthIndicator,
    HealthService,
    {
      provide: 'HEALTH_CHECK_INTERVAL',
      useValue: 30000, // 30 seconds
    },
  ],
  controllers: [HealthController],
  exports: [HealthService],
})
export class HealthModule {}
```

**Startup behavior:**
```typescript
// src/main.ts
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const healthService = app.get(HealthService);
  const health = await healthService.checkAll();

  if (health.status !== 'ok') {
    console.error('Health checks failed on startup:', health.details);
    process.exit(1);
  }

  await app.listen(3000);
}
```

---

## 5. Configuration Validation Schema

New configuration entries for all 5 databases.

```typescript
// src/shared/config/app.config.ts
import { IsString, IsNumber, IsBoolean, IsOptional, Min, Max, ValidateNested, Type } from 'class-validator';

export class Neo4jConfig {
  @IsString()
  uri: string;

  @IsString()
  username: string;

  @IsString()
  password: string;

  @IsNumber()
  @Min(1)
  @Max(100)
  maxConnectionPoolSize: number = 50;
}

export class TimescaleConfig {
  @IsString()
  host: string;

  @IsNumber()
  @Min(1)
  @Max(65535)
  port: number = 5432;

  @IsString()
  database: string;

  @IsString()
  username: string;

  @IsString()
  password: string;

  @IsNumber()
  @Min(1)
  @Max(100)
  maxConnections: number = 20;

  @IsNumber()
  @Min(1000)
  idleTimeoutMillis: number = 30000;

  @IsBoolean()
  enableCompression: boolean = true;

  @IsNumber()
  @Min(1)
  compressionIntervalDays: number = 7;
}

export class PostgresConfig {
  @IsString()
  host: string;

  @IsNumber()
  @Min(1)
  @Max(65535)
  port: number = 5432;

  @IsString()
  database: string;

  @IsString()
  adminUsername: string;

  @IsString()
  adminPassword: string;

  @IsString()
  runtimeUsername: string;

  @IsString()
  runtimePassword: string;

  @IsNumber()
  @Min(5)
  @Max(100)
  maxConnections: number = 20;
}

export class GrafeoConfig {
  @IsString()
  basePath: string = './grafeo-data';

  @IsNumber()
  @Min(256)
  pageSize: number = 4096;

  @IsBoolean()
  enableCompression: boolean = true;
}

export class AppConfig {
  @IsBoolean()
  debug: boolean = false;

  @ValidateNested()
  @Type(() => Neo4jConfig)
  neo4j: Neo4jConfig;

  @ValidateNested()
  @Type(() => TimescaleConfig)
  timescale: TimescaleConfig;

  @ValidateNested()
  @Type(() => PostgresConfig)
  postgres: PostgresConfig;

  @ValidateNested()
  @Type(() => GrafeoConfig)
  grafeo: GrafeoConfig;
}
```

**.env Example:**
```
DEBUG=false

NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=neo4j_dev_password
NEO4J_MAX_CONNECTION_POOL_SIZE=50

TIMESCALE_HOST=localhost
TIMESCALE_PORT=5432
TIMESCALE_DATABASE=sylphie
TIMESCALE_USERNAME=timescale_user
TIMESCALE_PASSWORD=timescale_password
TIMESCALE_MAX_CONNECTIONS=20
TIMESCALE_ENABLE_COMPRESSION=true

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=sylphie_system
POSTGRES_ADMIN_USERNAME=postgres_admin
POSTGRES_ADMIN_PASSWORD=admin_password
POSTGRES_RUNTIME_USERNAME=sylphie_runtime
POSTGRES_RUNTIME_PASSWORD=runtime_password

GRAFEO_BASE_PATH=/data/grafeo
```

---

## 6. Error Handling

### 6.1 Database-Specific Exceptions

```typescript
// src/shared/exceptions/database.exceptions.ts

export class DatabaseConnectionError extends SylphieException {
  constructor(public readonly database: string, cause: Error) {
    super(`Failed to connect to ${database}`, {
      database,
      originalError: cause.message,
    });
  }
}

export class DatabaseQueryError extends SylphieException {
  constructor(public readonly database: string, query: string, cause: Error) {
    super(`Query failed on ${database}`, {
      database,
      query: query.substring(0, 200), // truncate for logging
      originalError: cause.message,
    });
  }
}

export class RlsViolationError extends SylphieException {
  constructor(operation: string, userRole: string) {
    super(`RLS violation: ${userRole} cannot perform ${operation}`, {
      operation,
      userRole,
    });
  }
}

export class SchemaInitializationError extends SylphieException {
  constructor(public readonly resource: string, cause: Error) {
    super(`Failed to initialize schema for ${resource}`, {
      resource,
      originalError: cause.message,
    });
  }
}
```

### 6.2 Connection Failure Handling

**Startup failures:** Application fails fast with a clear message.

**Runtime failures:** Implement retry logic with exponential backoff for transient failures (e.g., connection pool exhaustion), but fail permanently for persistent errors (e.g., invalid credentials).

```typescript
// src/shared/database/retry.util.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
  } = options;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = Math.min(
          initialDelayMs * Math.pow(2, attempt - 1),
          maxDelayMs,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}
```

### 6.3 Log Levels

- **ERROR:** Connection failures, schema initialization failures, RLS violations
- **WARN:** Retry attempts, connection pool near-full, slow queries
- **INFO:** Connection established, schema initialized, health checks passed
- **DEBUG:** Query execution (in debug mode only)

---

## 7. Interface Compliance

Epic 0 defined these interfaces (stubs). Epic 1 implements them:

| Interface | E0 Location | E1 Implementation |
|-----------|------------|-------------------|
| `IWkgService` | `src/knowledge/interfaces/knowledge.interfaces.ts` | `src/knowledge/wkg/wkg.service.ts` + `src/knowledge/wkg-query.service.ts` |
| `IEventsService` | `src/events/interfaces/events.interfaces.ts` | `src/events/events.service.ts` |
| `IDriveStateReader` | `src/drive-engine/interfaces/drive-engine.interfaces.ts` | `src/drive-engine/drive-engine.service.ts` |
| `IGrafeoCoreKG` | `src/knowledge/interfaces/grafeo.interfaces.ts` | Grafeo npm package (wrapped by `OtherKgService`) |
| `ILearningService` | `src/learning/interfaces/learning.interfaces.ts` | Uses `IWkgService` to fulfill contract |

**Verification:** All subsystem modules should compile without errors when importing these interface tokens and calling methods.

---

## 8. Testing Strategy

### 8.1 Unit Tests (per module)

Each module provides:
- Mock database clients (Jest mocking)
- Isolated service tests (no real database)
- Configuration validation tests

```typescript
// src/knowledge/wkg/wkg.service.spec.ts
describe('WkgService', () => {
  let service: WkgService;
  let mockDriver: jest.Mocked<Driver>;

  beforeEach(() => {
    mockDriver = {
      session: jest.fn(() => ({
        run: jest.fn(),
        close: jest.fn(),
      })),
    } as any;

    // Provide mock via DI
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WkgService,
        { provide: NEO4J_DRIVER, useValue: mockDriver },
      ],
    }).compile();

    service = module.get<WkgService>(WkgService);
  });

  it('should upsert a node with correct provenance', async () => {
    const result = await service.upsertNode({
      label: 'TestNode',
      type: 'Test',
      provenance: 'GUARDIAN',
    });
    expect(result.confidence).toBe(0.60); // GUARDIAN base
  });
});
```

### 8.2 Integration Tests (Docker Compose)

Spin up all five databases in Docker, run real queries:

```yaml
# docker-compose.test.yml
version: '3.8'
services:
  neo4j:
    image: neo4j:5.12
    environment:
      NEO4J_AUTH: neo4j/dev_password
    ports:
      - "7687:7687"

  timescale:
    image: timescaledb/timescaledb:2.12.0-pg14
    environment:
      POSTGRES_PASSWORD: timescale_password
      POSTGRES_DB: sylphie_test
    ports:
      - "5433:5432"

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_PASSWORD: postgres_password
      POSTGRES_DB: sylphie_system_test
    ports:
      - "5434:5432"
```

Run integration tests:
```bash
docker-compose -f docker-compose.test.yml up -d
npm run test:integration
docker-compose -f docker-compose.test.yml down
```

### 8.3 RLS Enforcement Tests

```typescript
// src/shared/database/rls.spec.ts
describe('RLS Enforcement', () => {
  it('should prevent drive_rules writes via runtime pool', async () => {
    const runtimeClient = await runtimePool.connect();
    expect(
      runtimeClient.query('INSERT INTO drive_rules (...) VALUES (...)')
    ).rejects.toThrow(/permission denied/);
  });

  it('should allow admin pool to modify proposed_drive_rules', async () => {
    const adminClient = await adminPool.connect();
    expect(
      adminClient.query('INSERT INTO proposed_drive_rules (...)')
    ).resolves.toBeDefined();
  });
});
```

### 8.4 Health Check Tests

```typescript
// src/shared/health/health.spec.ts
describe('DatabaseHealthIndicator', () => {
  it('should report healthy when all databases are reachable', async () => {
    const health = await indicator.check([
      () => indicator.checkNeo4j(),
      () => indicator.checkTimescale(),
      () => indicator.checkPostgres(),
    ]);
    expect(health.status).toBe('ok');
  });

  it('should report degraded when one database is unreachable', async () => {
    // Shutdown Neo4j, check health
    expect(health.status).toBe('degraded');
  });
});
```

---

## 9. Risks & Mitigation

### Risk 1: Circular Module Dependency

**Scenario:** KnowledgeModule imports EventsModule, EventsModule imports KnowledgeModule for query logging.

**Mitigation:**
- **Never import subsystem modules into infrastructure modules.** KnowledgeModule and EventsModule are infrastructure; they never import DecisionMaking, Communication, etc.
- Use a shared event type (defined in SharedModule) for all event logging.
- If circular dependency is detected at startup, NestJS will throw immediately.

### Risk 2: Connection Pool Exhaustion

**Scenario:** Each subsystem opens a connection and never releases it.

**Mitigation:**
- Use factory providers with proper pooling (pg, neo4j-driver both provide connection pooling).
- Log pool utilization on every 100 connections (warn if > 80% used).
- Set reasonable idle timeouts (30 seconds default) to reclaim stale connections.
- Health checks verify pool health.

### Risk 3: Neo4j Constraint Conflicts

**Scenario:** OnModuleInit runs twice (e.g., in tests) and constraints already exist.

**Mitigation:**
- Use `CREATE CONSTRAINT ... IF NOT EXISTS` — idempotent, safe to re-run.

### Risk 4: TimescaleDB Hypertable Schema Mismatch

**Scenario:** Hypertable created with wrong partition interval; cannot be changed post-creation.

**Mitigation:**
- Store partition interval in configuration (default: 1 day).
- Document in CLAUDE.md which fields define the hypertable schema.
- Test schema creation in integration tests before merging.

### Risk 5: RLS Rule Bypass

**Scenario:** A subsystem gets the admin pool and writes to `drive_rules` unsupervised.

**Mitigation:**
- **Admin pool is NOT exported** from DatabaseModule. Only DatabaseService (internal to module) can request it.
- RLS is enforced at the database level — even if the app code tries to bypass it, the database will reject it.
- Integration tests verify RLS enforcement.

### Risk 6: Module Initialization Order

**Scenario:** DecisionMaking initializes before EventsModule is ready; tries to write events and fails.

**Mitigation:**
- NestJS initializes modules in dependency order.
- Declare module dependencies explicitly in `imports: []`.
- If order matters beyond dependency graph, use `ModuleRef.get()` to defer access in OnModuleInit.

### Risk 7: Async Factory Provider Timeout

**Scenario:** Neo4j driver factory takes 30 seconds to verify connectivity; startup hangs.

**Mitigation:**
- Set reasonable connection timeout in driver config (default: 5 seconds for neo4j-driver).
- If startup timeout is needed, configure in NestJS bootstrap (default is unbounded).

---

## 10. Ticket Breakdown Suggestion

Epic 1 should be split into 8-10 sequential / parallel tickets with clear dependencies:

### Phase A: Database Connection Providers (Tickets 1-3, can run in parallel)

**Ticket 1: PostgreSQL Database Module (Critical Path)**
- [ ] Create `src/shared/database/database.module.ts`
- [ ] Implement `pgAdminPoolProvider` and `pgRuntimePoolProvider`
- [ ] Implement `DatabaseService` wrapper
- [ ] Write RLS initialization logic
- [ ] Unit tests for pool connection logic
- [ ] Acceptance: Pool connects, RLS rules exist in PostgreSQL
- **Dependencies:** None
- **Effort:** 2-3 days

**Ticket 2: Neo4j Knowledge Module (Critical Path)**
- [ ] Create `src/knowledge/knowledge.module.ts`
- [ ] Implement `neo4jDriverProvider`
- [ ] Create `src/knowledge/wkg/wkg.service.ts` (replace stub)
- [ ] Implement constraint initialization on OnModuleInit
- [ ] Unit tests (mocked driver)
- [ ] Acceptance: Driver connects, constraints exist
- **Dependencies:** None (parallel with Ticket 1)
- **Effort:** 2-3 days

**Ticket 3: TimescaleDB Events Module (Critical Path)**
- [ ] Create `src/events/events.module.ts`
- [ ] Implement `timescalePoolProvider`
- [ ] Create `src/events/events.service.ts` (replace stub)
- [ ] Implement hypertable schema on OnModuleInit
- [ ] Unit tests (mocked pool)
- [ ] Acceptance: Pool connects, hypertable exists, can write events
- **Dependencies:** None (parallel with Tickets 1-2)
- **Effort:** 2-3 days

### Phase B: Embedded Graph Databases (Tickets 4-5, parallel)

**Ticket 4: Grafeo Integration (Self + Other KGs)**
- [ ] Create `src/knowledge/grafeo/self-kg.service.ts`
- [ ] Create `src/knowledge/grafeo/other-kg.service.ts` (wraps on-demand creation)
- [ ] Implement `IGrafeoCoreKG` interface (if not in E0)
- [ ] Schema initialization for both
- [ ] Unit tests
- [ ] Acceptance: Can create and query Self KG and per-person Other KGs
- **Dependencies:** None (parallel with A)
- **Effort:** 2 days

### Phase C: Integration & Configuration (Tickets 6-7)

**Ticket 5: Configuration Schema & Validation**
- [ ] Create `src/shared/config/app.config.ts` with all 5 database configs
- [ ] Class-validator rules per section 5
- [ ] .env.example with all variables
- [ ] Integration test verifying config validation
- [ ] Acceptance: App fails fast if env is malformed
- **Dependencies:** None (parallel with A-B)
- **Effort:** 1 day

**Ticket 6: AppModule Assembly (Critical Path)**
- [ ] Update `src/app.module.ts` to import all 5 database modules
- [ ] Verify no circular dependencies
- [ ] Type-check: `npx tsc --noEmit`
- [ ] Compile test: `npm run build`
- [ ] Acceptance: App starts, all modules initialize
- **Dependencies:** Tickets 1-5
- **Effort:** 1 day

### Phase D: Verification & Health (Tickets 7-8)

**Ticket 7: Health Check Implementation**
- [ ] Create `src/shared/health/` module
- [ ] Implement per-database health indicators
- [ ] Implement startup readiness check
- [ ] Create `/health` endpoint
- [ ] Integration test with all databases
- [ ] Acceptance: Startup fails if any database unhealthy
- **Dependencies:** Ticket 6
- **Effort:** 2 days

**Ticket 8: Docker Compose & Integration Tests**
- [ ] Create `docker-compose.yml` for all 5 databases (neo4j, timescale, postgres, volumes for grafeo)
- [ ] Create `docker-compose.test.yml` variant
- [ ] Write integration tests (real database, real queries)
- [ ] RLS enforcement tests (verify runtime pool cannot write to drive_rules)
- [ ] CI/CD configuration
- [ ] Acceptance: Integration tests pass in CI, RLS enforced
- **Dependencies:** Ticket 6, Ticket 7
- **Effort:** 3-4 days

**Ticket 9: Documentation & Cleanup**
- [ ] Update README with database setup instructions
- [ ] Document configuration in `.env.example`
- [ ] Session log: what was changed, known issues, gotchas
- [ ] Acceptance: New developer can start app with `docker-compose up && npm run dev`
- **Dependencies:** Ticket 8
- **Effort:** 1 day

### Dependency Graph

```
    Ticket 1 (PostgreSQL)
         |
         v
    Ticket 5 (Config) <-- Ticket 2 (Neo4j)
         |                    |
         |                    v
         |  Ticket 4 (Grafeo) <-- Ticket 3 (TimescaleDB)
         |       |
         v       v
    Ticket 6 (AppModule)
         |
         v
    Ticket 7 (Health)
         |
         v
    Ticket 8 (Integration)
         |
         v
    Ticket 9 (Docs)
```

**Total Effort:** 16-20 days

**Critical Path:** Tickets 1, 5, 6, 7, 8, 9 (12-13 days)

Tickets 2, 3, 4 can run in parallel with Ticket 1.

---

## 11. Success Criteria

Epic 1 is complete when:

1. **All connections work.** App starts without errors; health endpoint returns `status: ok`.
2. **Schemas exist.** Neo4j constraints, TimescaleDB hypertables, PostgreSQL tables all present.
3. **RLS enforced.** Runtime pool cannot write to `drive_rules`; admin pool can.
4. **Interfaces satisfied.** All services implement their E0-defined interfaces; subsystem modules can call them without error.
5. **No circular dependencies.** NestJS starts without warnings; `npm run build` succeeds.
6. **Integration tests pass.** Docker-based tests verify real database queries.
7. **Configuration validated.** App fails fast if env is malformed.
8. **Health checks work.** Startup readiness + periodic monitoring both functional.
9. **Session log written.** `docs/sessions/{date}-epic1-database-infrastructure.md` documents changes.

---

## 12. Key Architectural Decisions

### D7: Two PostgreSQL Pools

**Status:** Approved (from E0)
**Rationale:** Admin pool for setup operations, runtime pool for DriveEngine reads (with RLS enforcing that only SELECT on drive_rules is allowed). This prevents even a bug in the app from accidentally modifying the drive evaluation function.
**Implementation Detail:** Admin pool is private to DatabaseModule; never exported.

### D8: Grafeo Instances Per Person

**Status:** New decision for E1
**Rationale:** Each person gets their own embedded KG. This prevents cross-contamination and allows query optimization per-person.
**Implementation Detail:** OtherKgService caches instances; creates on-demand via `getOrCreateKg(personId)`.

### D9: Health Check on Startup

**Status:** New decision for E1
**Rationale:** Application should not accept traffic unless all infrastructure is healthy.
**Implementation Detail:** `main.ts` calls `HealthService.checkAll()` before `app.listen()`.

### D10: Factory Providers for All Database Connections

**Status:** New decision for E1
**Rationale:** Async initialization + testability (easy to mock). NestJS auto-resolves dependency order.
**Implementation Detail:** All database providers use `FactoryProvider<T>` pattern with `inject: [ConfigService]`.

---

## Appendix: Schema Sketches

### PostgreSQL drive_rules Table

```sql
-- Admin pool can create this during initialization
CREATE TABLE IF NOT EXISTS drive_rules (
  id SERIAL PRIMARY KEY,
  event_pattern TEXT NOT NULL,           -- e.g., "prediction_error > 0.15"
  affected_drives JSON NOT NULL,         -- e.g., [{"drive": "anxiety", "delta": +0.05}]
  provenance TEXT NOT NULL,              -- "CANON" for immutable, "GUARDIAN" for approved
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- RLS: Only admin can read/write
ALTER TABLE drive_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_access ON drive_rules
  FOR ALL TO admin_role
  USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY runtime_readonly ON drive_rules
  FOR SELECT TO runtime_role
  USING (TRUE);

-- Proposed rules (runtime can write here)
CREATE TABLE IF NOT EXISTS proposed_drive_rules (
  id SERIAL PRIMARY KEY,
  event_pattern TEXT NOT NULL,
  affected_drives JSON NOT NULL,
  proposed_by TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  created_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  guardian_notes TEXT
);

ALTER TABLE proposed_drive_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_access ON proposed_drive_rules FOR ALL TO admin_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY runtime_write ON proposed_drive_rules
  FOR INSERT TO runtime_role
  WITH CHECK (TRUE);
CREATE POLICY runtime_read ON proposed_drive_rules
  FOR SELECT TO runtime_role
  USING (status IN ('approved', 'rejected') OR proposed_by = current_user);
```

### Neo4j Constraints

```cypher
CREATE CONSTRAINT node_id_unique IF NOT EXISTS
  FOR (n:Node) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT node_label_type_unique IF NOT EXISTS
  FOR (n:Node) REQUIRE (n.label, n.type) IS UNIQUE;

CREATE CONSTRAINT rel_id_unique IF NOT EXISTS
  FOR (r:RELATIONSHIP) REQUIRE r.id IS UNIQUE;

CREATE INDEX rel_source_target IF NOT EXISTS
  FOR () -[r:RELATIONSHIP]-> ()
  ON (r.sourceId, r.targetId);

CREATE INDEX node_confidence IF NOT EXISTS
  FOR (n:Node) ON (n.confidence);

CREATE INDEX node_provenance IF NOT EXISTS
  FOR (n:Node) ON (n.provenance);
```

### TimescaleDB Hypertable

```sql
-- Create events table as hypertable
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,        -- 'prediction', 'action', 'observation', etc.
  timestamp TIMESTAMP NOT NULL,
  drive_state JSONB,               -- Full drive vector at time of event
  subsystem TEXT NOT NULL,         -- 'decision', 'communication', 'learning', 'drive', 'planning'
  data JSONB,                      -- Event-specific payload
  created_at TIMESTAMP DEFAULT NOW()
);

-- Convert to hypertable (TimescaleDB extension must be enabled first)
SELECT create_hypertable('events', 'timestamp', if_not_exists => TRUE);

-- Enable compression
ALTER TABLE events SET (timescaledb.compress = on);
SELECT add_compression_policy('events', INTERVAL '7 days');

-- Retention policy: keep 90 days of events
SELECT add_retention_policy('events', INTERVAL '90 days');

-- Index for common queries
CREATE INDEX ON events (event_type, timestamp DESC) WHERE timestamp > NOW() - INTERVAL '30 days';
CREATE INDEX ON events (subsystem, timestamp DESC) WHERE timestamp > NOW() - INTERVAL '30 days';
```

---

**Analysis completed by Forge, NestJS/TypeScript Systems Architect**

**Next steps:** Validate against CANON, align with Guardian (Jim), sequence into tickets.

