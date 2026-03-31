# Epic 9: Dashboard API and WebSocket Gateways -- Forge Architectural Analysis

**Status:** Planning
**Epic Scope:** HTTP REST API, WebSocket gateways, health monitoring, telemetry streaming, development metrics
**Analysis Date:** 2026-03-29
**Analyzer:** Forge (NestJS/TypeScript Systems Architect)

---

## Executive Summary

Epic 9 builds the **WebModule** — the HTTP/WebSocket API surface through which the React frontend dashboard observes and interacts with Sylphie's internal state. This is a **pure consumer module**: it reads from subsystems (Events, Knowledge, Drive Engine, Decision Making), never writes to domain logic. All mutations go through application-layer services.

The critical architectural principle: **WebModule is a gateway, not a brain.** It does not make decisions, modify drive state, or generate knowledge. It translates internal state into API responses and streams.

Core responsibilities:
1. **Health & Observability** — all five databases, subsystem health status
2. **Drive State API** — real-time drive values, drive history, read-only state reflection
3. **Knowledge Graph API** — read-only WKG query endpoint with pagination for visualization
4. **Conversation History** — retrieve and stream past interactions
5. **Telemetry WebSocket** — drive ticks, action selections, predictions, outcomes
6. **Development Metrics API** — Type 1/Type 2 ratio, prediction MAE, provenance distribution, behavioral diversity
7. **System Configuration** — version, feature flags, debug modes (for development)

WebModule dependencies:
- **E2 (Events)** — queries TimescaleDB for conversation history, telemetry, metrics
- **E3 (Knowledge)** — queries WKG for graph snapshots and statistics
- **E4 (Drive Engine)** — reads drive state via IDriveStateReader (read-only)
- **E1 (Decision Making)** — optionally queries episodic memory for context (depends on architecture)

This analysis covers module structure, NestJS patterns (controllers, gateways, guards, interceptors), interface design, dependency injection, WebSocket architecture, error handling, configuration, and risks.

---

## 1. Module Structure & Directory Layout

### 1.1 Directory Tree

```
src/web/
├── web.module.ts                          # Module declaration
├── web.service.ts                         # Public facade (if needed; may be minimal)
├── controllers/
│   ├── health.controller.ts               # GET /health
│   ├── drives.controller.ts               # GET /drives/*, POST /drives/debug/*
│   ├── graph.controller.ts                # GET /graph/*, graph query APIs
│   ├── conversation.controller.ts         # GET /conversation/history
│   └── metrics.controller.ts              # GET /metrics/* (development)
├── gateways/
│   ├── telemetry.gateway.ts              # WebSocket: drive ticks, predictions, actions
│   ├── graph-updates.gateway.ts          # WebSocket: WKG changes (real-time feed)
│   ├── conversation.gateway.ts           # WebSocket: chat input/output
│   └── connection-manager.service.ts     # Shared channel/client management
├── guards/
│   ├── development.guard.ts              # Rate limiting, feature gates
│   └── query.guard.ts                    # Parameter validation
├── interceptors/
│   ├── logging.interceptor.ts            # Request/response logging
│   └── error-mapping.interceptor.ts      # Domain exceptions → HTTP responses
├── filters/
│   ├── exception.filter.ts               # Global exception handler for WS + REST
│   └── ws-exception.filter.ts            # WebSocket-specific error frames
├── decorators/
│   ├── require-auth.decorator.ts         # (Future auth implementation)
│   ├── drive-context.decorator.ts        # Injects current drive state
│   └── user.decorator.ts                 # Extracts user/session from request
├── dtos/
│   ├── health.dto.ts
│   ├── drives.dto.ts
│   ├── graph.dto.ts
│   ├── conversation.dto.ts
│   ├── telemetry.dto.ts
│   └── metrics.dto.ts
├── interfaces/
│   ├── web.interfaces.ts                 # Top-level public interfaces
│   ├── websocket.interfaces.ts           # WebSocket frame types
│   └── web.tokens.ts                     # DI injection tokens
├── exceptions/
│   ├── web.exceptions.ts                 # Domain-specific HTTP errors
│   └── websocket.errors.ts               # WebSocket error frame types
├── utils/
│   ├── paginator.ts                      # Pagination helper for graph queries
│   ├── graph-serializer.ts               # Neo4j nodes/edges → JSON
│   └── websocket-message.ts              # Message framing utilities
├── index.ts                               # Barrel exports
└── README.md                              # Module documentation
```

### 1.2 Configuration Schema

WebModule requires configuration for:
- HTTP server port (default 3000, override via PORT env)
- CORS policy (frontend origins)
- WebSocket path prefix (default /ws)
- Rate limiting (optional per development mode)
- Debug flags (enable/disable debug endpoints)

```typescript
// src/web/web.config.ts (merged into global config)
export interface WebConfig {
  http: {
    port: number;
    host: string;
  };
  cors: {
    origin: string | string[];
    credentials: boolean;
  };
  websocket: {
    pathPrefix: string;         // e.g., '/ws'
    maxClients?: number;        // Per gateway
    heartbeatInterval?: number; // ms, keep-alives
  };
  security: {
    rateLimit?: {
      windowMs: number;
      max: number;
    };
    developmentMode: boolean;
  };
}
```

### 1.3 Module Declaration

```typescript
// src/web/web.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

// Controllers
import { HealthController } from './controllers/health.controller';
import { DrivesController } from './controllers/drives.controller';
import { GraphController } from './controllers/graph.controller';
import { ConversationController } from './controllers/conversation.controller';
import { MetricsController } from './controllers/metrics.controller';

// Gateways
import { TelemetryGateway } from './gateways/telemetry.gateway';
import { GraphUpdatesGateway } from './gateways/graph-updates.gateway';
import { ConversationGateway } from './gateways/conversation.gateway';
import { ConnectionManagerService } from './gateways/connection-manager.service';

// Guards, Interceptors, Filters
import { DevelopmentGuard } from './guards/development.guard';
import { QueryGuard } from './guards/query.guard';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { ErrorMappingInterceptor } from './interceptors/error-mapping.interceptor';
import { ExceptionFilter } from './filters/exception.filter';
import { WsExceptionFilter } from './filters/ws-exception.filter';

// Services
import { WebService } from './web.service';

// Dependencies
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { EventsModule } from '../events/events.module';
import { DriveEngineModule } from '../drive-engine/drive-engine.module';
import { DecisionMakingModule } from '../decision-making/decision-making.module';

@Module({
  imports: [
    ConfigModule,
    KnowledgeModule,        // Read-only WKG access
    EventsModule,           // Read-only event queries
    DriveEngineModule,      // Read-only drive state
    DecisionMakingModule,   // Optional: for episodic context
  ],
  controllers: [
    HealthController,
    DrivesController,
    GraphController,
    ConversationController,
    MetricsController,
  ],
  providers: [
    // Services
    WebService,
    ConnectionManagerService,

    // Gateways
    TelemetryGateway,
    GraphUpdatesGateway,
    ConversationGateway,

    // Guards (global provider, registered in guards array below)
    DevelopmentGuard,
    QueryGuard,

    // Interceptors & Filters (registered in app.module)
    LoggingInterceptor,
    ErrorMappingInterceptor,
    ExceptionFilter,
    WsExceptionFilter,
  ],
  exports: [
    WebService,
    ConnectionManagerService,
  ],
})
export class WebModule {}
```

---

## 2. NestJS Patterns & Framework Integration

### 2.1 Controller Pattern

Each controller is a **read-only facade** into one subsystem's observable state. No business logic.

```typescript
// src/web/controllers/health.controller.ts
import { Controller, Get, HttpCode } from '@nestjs/common';
import { HealthService } from './health.service';
import { HealthCheckResponse } from '../dtos/health.dto';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * GET /health
   * Returns aggregated health status of all five databases and subsystems.
   * Non-blocking; returns cached status if up-to-date.
   */
  @Get()
  @HttpCode(200)
  async getHealth(): Promise<HealthCheckResponse> {
    return this.healthService.getHealthStatus();
  }
}
```

Key patterns:
- Controllers inject read-only services (no mutations)
- DTOs describe response shapes explicitly
- HTTP status codes are explicit (@HttpCode)
- Async methods return Promises; NestJS handles serialization
- No business logic in controller methods (only delegation)

### 2.2 WebSocket Gateway Pattern

Gateways are **dual-mode**: they handle incoming events and broadcast outgoing streams.

```typescript
// src/web/gateways/telemetry.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Inject, UseGuards, UseFilters } from '@nestjs/common';
import { IDriveStateReader } from '../../drive-engine/interfaces/drive-state.interface';
import { DRIVE_STATE_READER } from '../../drive-engine/tokens';
import { EventsService } from '../../events/events.service';
import { ConnectionManagerService } from './connection-manager.service';
import { DevelopmentGuard } from '../guards/development.guard';
import { WsExceptionFilter } from '../filters/ws-exception.filter';

@WebSocketGateway({
  namespace: '/ws/telemetry',
  transports: ['websocket'],
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  },
})
@UseFilters(WsExceptionFilter)
@UseGuards(DevelopmentGuard)
export class TelemetryGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger('TelemetryGateway');

  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
    private readonly eventsService: EventsService,
    private readonly connectionManager: ConnectionManagerService,
  ) {}

  /**
   * handleConnection
   * Client subscribes to telemetry stream.
   * On connection, send current drive state snapshot and open tap for real-time updates.
   */
  handleConnection(client: Socket): void {
    this.logger.debug(`Client ${client.id} connected`);
    this.connectionManager.registerClient(client.id, 'telemetry');

    // Send initial state
    const driveState = this.driveStateReader.getCurrentState();
    client.emit('drive-snapshot', driveState);

    // Subscribe to real-time drive ticks
    this.subscribeToRealTime(client.id);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client ${client.id} disconnected`);
    this.connectionManager.unregisterClient(client.id, 'telemetry');
  }

  /**
   * subscribeToRealTime
   * Opens a subscription to EventsService that emits drive state changes.
   * This is where the real-time magic happens.
   */
  private subscribeToRealTime(clientId: string): void {
    const subscription = this.eventsService.subscribeToDriveTicks().subscribe({
      next: (driveTick) => {
        this.server.to(clientId).emit('drive-tick', {
          timestamp: driveTick.timestamp,
          drives: driveTick.driveState,
          arousal: driveTick.arousal,
        });
      },
      error: (err) => {
        this.logger.error(`Subscription error for ${clientId}:`, err);
        this.server.to(clientId).emit('error', { message: 'Stream error' });
      },
    });
  }

  /**
   * requestHistoricalData
   * Client can request a window of past telemetry (for graph rewind).
   */
  @SubscribeMessage('request-historical')
  async requestHistoricalData(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { startTime: string; endTime: string },
  ): Promise<void> {
    const history = await this.eventsService.queryDriveHistory({
      startTime: new Date(payload.startTime),
      endTime: new Date(payload.endTime),
    });
    client.emit('historical-data', history);
  }
}
```

Key patterns:
- Gateway class implements `OnGatewayConnection`, `OnGatewayDisconnect`
- `@WebSocketGateway()` decorator configures namespace, transport, CORS
- `@WebSocketServer()` injects the Socket.io Server instance
- `handleConnection` / `handleDisconnect` manage client lifecycle
- `@SubscribeMessage('event-name')` decorates RPC handlers
- Subscriptions to EventsService are RxJS observables
- Error handling routes through `WsExceptionFilter`

### 2.3 Guard Pattern

Guards enforce preconditions before request/gateway connection.

```typescript
// src/web/guards/development.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DevelopmentGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const isDevelopment = this.configService.get('security.developmentMode');

    if (!isDevelopment) {
      // In production, block metrics endpoints and debug gateways
      const request = context.switchToHttp().getRequest();
      if (request.path.includes('/debug') || request.path.includes('/metrics')) {
        throw new ForbiddenException('Debug endpoints disabled in production');
      }
    }

    return true;
  }
}
```

### 2.4 Interceptor Pattern

Interceptors wrap request/response lifecycle for cross-cutting concerns.

```typescript
// src/web/interceptors/error-mapping.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Observable, catchError } from 'rxjs';
import {
  KnowledgeGraphError,
  EventsError,
  DriveEngineError,
} from '../../shared/exceptions';

@Injectable()
export class ErrorMappingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError((error) => {
        if (error instanceof KnowledgeGraphError) {
          throw new BadRequestException(
            `WKG query failed: ${error.message}`,
          );
        }
        if (error instanceof EventsError) {
          throw new BadRequestException(
            `Events query failed: ${error.message}`,
          );
        }
        if (error instanceof DriveEngineError) {
          // Drive engine errors are system-level; don't expose details
          throw new InternalServerErrorException(
            'Drive evaluation failed (check server logs)',
          );
        }
        throw error;
      }),
    );
  }
}
```

### 2.5 Exception Filter Pattern

Filters catch exceptions and format responses for both HTTP and WebSocket.

```typescript
// src/web/filters/exception.filter.ts
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.getMessage();
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
```

```typescript
// src/web/filters/ws-exception.filter.ts
import { Catch, ArgumentsHost } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';

@Catch(WsException)
export class WsExceptionFilter extends BaseWsExceptionFilter {
  catch(exception: WsException, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient();
    const error = exception.getError();

    client.emit('error', {
      code: 'WS_ERROR',
      message: typeof error === 'string' ? error : error.message,
      timestamp: new Date().toISOString(),
    });
  }
}
```

---

## 3. Interface Design & DTOs

### 3.1 Top-Level Public Interface

```typescript
// src/web/interfaces/web.interfaces.ts

/**
 * IWebService
 * Public facade for WebModule. Read-only; delegates to subsystems.
 */
export interface IWebService {
  /**
   * Get aggregated health status of all subsystems and databases.
   */
  getHealthStatus(): Promise<HealthCheckResponse>;

  /**
   * Get current drive state snapshot.
   */
  getDriveState(): Promise<DriveStateSnapshot>;

  /**
   * Query the World Knowledge Graph with pagination.
   * @param query Neo4j Cypher query
   * @param params Query parameters
   * @param limit Pagination limit
   * @param offset Pagination offset
   */
  queryGraph(
    query: string,
    params: Record<string, any>,
    limit: number,
    offset: number,
  ): Promise<GraphQueryResponse>;

  /**
   * Get conversation history.
   * @param limit Number of recent exchanges
   * @param offset Pagination offset
   */
  getConversationHistory(
    limit: number,
    offset: number,
  ): Promise<ConversationHistoryResponse>;

  /**
   * Get development metrics (Type 1/Type 2 ratio, etc.).
   * Only available in development mode.
   */
  getMetrics(): Promise<MetricsResponse>;
}

/**
 * IDriveStateReader
 * Read-only view of current drive state.
 * Injected from DriveEngineModule; WebModule never writes to it.
 */
export interface IDriveStateReader {
  getCurrentState(): DriveState;
  getHistoricalState(timeRange: TimeRange): Promise<DriveStateTimeseries[]>;
}

/**
 * IEventsTelemetry
 * Provides event streams for real-time dashboard updates.
 * Injected from EventsModule.
 */
export interface IEventsTelemetry {
  subscribeToDriveTicks(): Observable<DriveTick>;
  subscribeToActions(): Observable<ActionEvent>;
  subscribeToPredictions(): Observable<PredictionEvent>;
}

/**
 * IConnectionManager
 * Manages WebSocket client lifecycle and message routing.
 */
export interface IConnectionManager {
  registerClient(clientId: string, gateway: string): void;
  unregisterClient(clientId: string, gateway: string): void;
  broadcast(gateway: string, event: string, payload: any): void;
  sendToClient(clientId: string, event: string, payload: any): void;
}
```

### 3.2 DTO Examples

```typescript
// src/web/dtos/health.dto.ts
import { Exclude, Expose } from 'class-transformer';

@Expose()
export class DatabaseStatus {
  name: string;              // 'neo4j', 'timescaledb', etc.
  connected: boolean;
  latency: number;           // milliseconds
  lastChecked: Date;
}

@Expose()
export class HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'critical';
  timestamp: Date;
  databases: DatabaseStatus[];
  subsystems: {
    [key: string]: {
      status: 'ready' | 'initializing' | 'error';
      message?: string;
    };
  };
}

// src/web/dtos/drives.dto.ts
@Expose()
export class DriveState {
  // Core drives
  systemHealth: number;
  moralValence: number;
  integrity: number;
  cognitiveAwareness: number;

  // Complement drives
  guilt: number;
  curiosity: number;
  boredom: number;
  anxiety: number;
  satisfaction: number;
  sadness: number;
  informationIntegrity: number;
  social: number;

  timestamp: Date;
  arousal: number;  // Overall activation level
}

@Expose()
export class DriveStateSnapshot {
  current: DriveState;
  recent: DriveState[];  // Last 10 ticks for trend visualization
}

@Expose()
export class DriveHistory {
  timeRange: { start: Date; end: Date };
  samples: DriveState[];  // One per tick in range
  stats: {
    mean: { [key: string]: number };
    std: { [key: string]: number };
    min: { [key: string]: number };
    max: { [key: string]: number };
  };
}

// src/web/dtos/graph.dto.ts
@Expose()
export class GraphNode {
  id: string;
  labels: string[];  // ['Entity', 'Person', 'Thing', ...]
  properties: Record<string, any>;
  provenance: 'SENSOR' | 'GUARDIAN' | 'LLM_GENERATED' | 'INFERENCE';
  confidence: number;
}

@Expose()
export class GraphEdge {
  id: string;
  source: string;    // Node ID
  target: string;    // Node ID
  type: string;      // Relationship type
  properties: Record<string, any>;
  provenance: 'SENSOR' | 'GUARDIAN' | 'LLM_GENERATED' | 'INFERENCE';
  confidence: number;
}

@Expose()
export class GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  pageInfo: {
    hasMore: boolean;
    nextOffset: number;
    totalNodes: number;
  };
}

@Expose()
export class GraphStats {
  nodeCount: number;
  edgeCount: number;
  provenance: {
    SENSOR: number;
    GUARDIAN: number;
    LLM_GENERATED: number;
    INFERENCE: number;
  };
  confidenceDistribution: {
    [key: string]: number; // Histogram: confidence ranges -> count
  };
}

// src/web/dtos/conversation.dto.ts
@Expose()
export class ConversationMessage {
  id: string;
  timestamp: Date;
  speaker: 'user' | 'sylphie';
  text: string;
  driveState?: DriveState;  // Drive state at time of message
  hasLearnable: boolean;    // Whether this was marked for learning
}

@Expose()
export class ConversationHistoryResponse {
  messages: ConversationMessage[];
  pageInfo: {
    hasMore: boolean;
    nextOffset: number;
    totalMessages: number;
  };
}

// src/web/dtos/metrics.dto.ts
@Expose()
export class MetricsResponse {
  timestamp: Date;
  type1Type2Ratio: {
    type1Decisions: number;
    type2Decisions: number;
    ratio: number;
  };
  predictionAccuracy: {
    mae: number;              // Mean Absolute Error
    lastN: number;            // Over last N predictions
    recentTrend: 'improving' | 'stable' | 'degrading';
  };
  provenanceRatio: {
    sensor: number;
    guardian: number;
    llmGenerated: number;
    inference: number;
  };
  behavioralDiversity: {
    uniqueActionsLastDay: number;
    uniqueActionsLastWeek: number;
    repetitionRate: number;   // 0-1
  };
  graphHealth: {
    nodeCount: number;
    edgeCount: number;
    averageConfidence: number;
    contradictions: number;
  };
}
```

---

## 4. Dependency Injection & Module Wiring

### 4.1 Injection Tokens

```typescript
// src/web/interfaces/web.tokens.ts
export const WEB_SERVICE = Symbol('WEB_SERVICE');
export const DRIVE_STATE_READER = Symbol('DRIVE_STATE_READER');
export const EVENTS_TELEMETRY = Symbol('EVENTS_TELEMETRY');
export const CONNECTION_MANAGER = Symbol('CONNECTION_MANAGER');
export const GRAPH_QUERY_SERVICE = Symbol('GRAPH_QUERY_SERVICE');
export const CONVERSATION_SERVICE = Symbol('CONVERSATION_SERVICE');
export const METRICS_SERVICE = Symbol('METRICS_SERVICE');
```

### 4.2 Service Injection in Controllers

```typescript
// src/web/controllers/drives.controller.ts
import { Controller, Get, Param, Inject } from '@nestjs/common';
import { DRIVE_STATE_READER } from '../interfaces/web.tokens';
import { IDriveStateReader } from '../../drive-engine/interfaces/drive-state.interface';
import { DriveStateSnapshot, DriveHistory } from '../dtos/drives.dto';

@Controller('api/drives')
export class DrivesController {
  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,
  ) {}

  /**
   * GET /api/drives/current
   */
  @Get('current')
  async getCurrentDriveState(): Promise<DriveStateSnapshot> {
    return {
      current: this.driveStateReader.getCurrentState(),
      recent: await this.driveStateReader.getHistoricalState({
        lookback: 10, // Last 10 ticks
      }),
    };
  }

  /**
   * GET /api/drives/history/:timeRange
   * timeRange: '1h', '1d', '1w'
   */
  @Get('history/:timeRange')
  async getDriveHistory(@Param('timeRange') timeRange: string): Promise<DriveHistory> {
    // Parse timeRange and calculate start/end
    const { start, end } = this.parseTimeRange(timeRange);
    const samples = await this.driveStateReader.getHistoricalState({
      start,
      end,
    });

    // Compute stats
    return this.computeStats(samples, start, end);
  }

  private parseTimeRange(range: string): { start: Date; end: Date } {
    const now = new Date();
    let start = new Date();
    switch (range) {
      case '1h':
        start.setHours(start.getHours() - 1);
        break;
      case '1d':
        start.setDate(start.getDate() - 1);
        break;
      case '1w':
        start.setDate(start.getDate() - 7);
        break;
    }
    return { start, end: now };
  }

  private computeStats(samples: any[], start: Date, end: Date): DriveHistory {
    // Aggregate stats across samples
    return {
      timeRange: { start, end },
      samples,
      stats: {
        mean: {},
        std: {},
        min: {},
        max: {},
      },
    };
  }
}
```

### 4.3 Gateway Dependency Injection

```typescript
// Gateways inject read-only services from upstream modules
// They never call mutating methods.

@WebSocketGateway({
  namespace: '/ws/telemetry',
})
export class TelemetryGateway implements OnGatewayConnection {
  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    @Inject(EVENTS_TELEMETRY)
    private readonly eventsTelemetry: IEventsTelemetry,

    @Inject(CONNECTION_MANAGER)
    private readonly connectionManager: IConnectionManager,
  ) {}

  // Implementation follows...
}
```

---

## 5. WebSocket Architecture

### 5.1 Channel-Based Gateway Design

The WebModule uses **Socket.io** (via NestJS @nestjs/websockets adapter) with namespace-based channels:

| Gateway | Namespace | Purpose |
|---------|-----------|---------|
| TelemetryGateway | `/ws/telemetry` | Drive ticks, action selections, predictions, outcomes |
| GraphUpdatesGateway | `/ws/graph` | WKG node/edge changes, deletions, confidence updates |
| ConversationGateway | `/ws/conversation` | Chat messages, real-time input processing |

Each gateway is independent; clients connect to one or more namespaces.

### 5.2 Connection Manager Service

Centralized client lifecycle management:

```typescript
// src/web/gateways/connection-manager.service.ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ConnectionManagerService {
  private readonly logger = new Logger('ConnectionManager');
  private clients: Map<string, ClientMetadata> = new Map();

  /**
   * Track a new client connection.
   */
  registerClient(clientId: string, gateway: string): void {
    if (!this.clients.has(clientId)) {
      this.clients.set(clientId, {
        id: clientId,
        gateway,
        connectedAt: new Date(),
        subscriptions: [],
      });
    }
    this.logger.debug(`Registered ${clientId} on ${gateway}`);
  }

  /**
   * Remove a client.
   */
  unregisterClient(clientId: string, gateway: string): void {
    if (this.clients.has(clientId)) {
      const metadata = this.clients.get(clientId);
      // Cleanup subscriptions
      metadata.subscriptions.forEach((sub) => sub.unsubscribe?.());
      this.clients.delete(clientId);
      this.logger.debug(`Unregistered ${clientId} from ${gateway}`);
    }
  }

  /**
   * Broadcast event to all clients in a gateway.
   */
  broadcast(gateway: string, event: string, payload: any): void {
    let count = 0;
    for (const [clientId, metadata] of this.clients.entries()) {
      if (metadata.gateway === gateway) {
        // This is handled by Socket.io server directly in gateways
        count++;
      }
    }
    this.logger.debug(`Broadcast ${event} to ${count} clients in ${gateway}`);
  }

  /**
   * Send event to specific client.
   */
  sendToClient(clientId: string, event: string, payload: any): void {
    if (this.clients.has(clientId)) {
      // Socket.io handles routing
      this.logger.debug(`Sent ${event} to ${clientId}`);
    }
  }

  /**
   * Track a subscription for cleanup on disconnect.
   */
  addSubscription(clientId: string, subscription: Subscription): void {
    if (this.clients.has(clientId)) {
      this.clients.get(clientId).subscriptions.push(subscription);
    }
  }

  getClientCount(gateway?: string): number {
    if (!gateway) return this.clients.size;
    return Array.from(this.clients.values()).filter(
      (c) => c.gateway === gateway,
    ).length;
  }
}

interface ClientMetadata {
  id: string;
  gateway: string;
  connectedAt: Date;
  subscriptions: Subscription[];
}
```

### 5.3 Message Framing

Standardized message format for all WebSocket events:

```typescript
// src/web/utils/websocket-message.ts

export interface WebSocketMessage<T = any> {
  type: 'command' | 'event' | 'stream' | 'error';
  event: string;
  payload: T;
  timestamp: Date;
  sequence?: number;  // For ordering on client side
}

export interface WebSocketStreamFrame<T = any> extends WebSocketMessage<T> {
  type: 'stream';
  isLast?: boolean;   // Marks end of stream segment
}

export interface WebSocketError {
  type: 'error';
  code: string;
  message: string;
  timestamp: Date;
}

/**
 * Helper to construct frames.
 */
export class WebSocketFrameBuilder {
  static event<T>(name: string, payload: T): WebSocketMessage<T> {
    return {
      type: 'event',
      event: name,
      payload,
      timestamp: new Date(),
    };
  }

  static stream<T>(name: string, payload: T, isLast?: boolean): WebSocketStreamFrame<T> {
    return {
      type: 'stream',
      event: name,
      payload,
      timestamp: new Date(),
      isLast,
    };
  }

  static error(code: string, message: string): WebSocketError {
    return {
      type: 'error',
      code,
      message,
      timestamp: new Date(),
    };
  }
}
```

### 5.4 Telemetry Gateway Deep Dive

```typescript
// src/web/gateways/telemetry.gateway.ts (extended)

@WebSocketGateway({
  namespace: '/ws/telemetry',
  transports: ['websocket'],
  cors: { origin: '*', credentials: true },
})
@UseFilters(WsExceptionFilter)
export class TelemetryGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger('TelemetryGateway');

  // Keep active subscriptions mapped to clients
  private clientSubscriptions: Map<string, Subscription[]> = new Map();

  constructor(
    @Inject(DRIVE_STATE_READER)
    private readonly driveStateReader: IDriveStateReader,

    @Inject(EVENTS_TELEMETRY)
    private readonly eventsTelemetry: IEventsTelemetry,

    @Inject(CONNECTION_MANAGER)
    private readonly connectionManager: IConnectionManager,
  ) {}

  handleConnection(client: Socket): void {
    this.logger.debug(`[${client.id}] Connected`);
    this.connectionManager.registerClient(client.id, 'telemetry');

    // Send initial snapshot
    const snapshot = {
      drives: this.driveStateReader.getCurrentState(),
      timestamp: new Date(),
    };
    client.emit('snapshot', WebSocketFrameBuilder.event('drive-snapshot', snapshot));

    // Open subscriptions
    this.openSubscriptions(client.id);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`[${client.id}] Disconnected`);
    this.connectionManager.unregisterClient(client.id, 'telemetry');

    // Cleanup subscriptions
    const subs = this.clientSubscriptions.get(client.id);
    if (subs) {
      subs.forEach((sub) => sub.unsubscribe());
      this.clientSubscriptions.delete(client.id);
    }
  }

  /**
   * Open real-time subscriptions for a client.
   * Each subscription pushes updates through Socket.io.
   */
  private openSubscriptions(clientId: string): void {
    const subs: Subscription[] = [];

    // Drive tick stream
    const driveSub = this.eventsTelemetry.subscribeToDriveTicks().subscribe({
      next: (tick) => {
        this.server.to(clientId).emit(
          'drive-tick',
          WebSocketFrameBuilder.stream('drive-tick', {
            timestamp: tick.timestamp,
            drives: tick.driveState,
            arousal: tick.arousal,
          }),
        );
      },
      error: (err) => {
        this.logger.error(`Drive subscription error for ${clientId}:`, err);
        this.server.to(clientId).emit(
          'error',
          WebSocketFrameBuilder.error('STREAM_ERROR', 'Drive stream failed'),
        );
      },
    });
    subs.push(driveSub);

    // Action selection stream
    const actionSub = this.eventsTelemetry.subscribeToActions().subscribe({
      next: (action) => {
        this.server.to(clientId).emit(
          'action',
          WebSocketFrameBuilder.stream('action-selected', {
            timestamp: action.timestamp,
            action: action.action,
            type: action.type,  // 'Type1' | 'Type2'
            reasoning: action.reasoning,
          }),
        );
      },
    });
    subs.push(actionSub);

    // Prediction stream
    const predictionSub = this.eventsTelemetry
      .subscribeToPredictions()
      .subscribe({
        next: (pred) => {
          this.server.to(clientId).emit(
            'prediction',
            WebSocketFrameBuilder.stream('prediction', {
              timestamp: pred.timestamp,
              action: pred.action,
              predictions: pred.predictions,
              outcome: pred.outcome,  // null until evaluated
              mae: pred.mae,          // null until evaluated
            }),
          );
        },
      });
    subs.push(predictionSub);

    this.clientSubscriptions.set(clientId, subs);
  }

  /**
   * Client can request a replay of telemetry data (e.g., for debugging).
   */
  @SubscribeMessage('request-replay')
  async requestReplay(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { startTime: string; endTime: string },
  ): Promise<void> {
    const start = new Date(payload.startTime);
    const end = new Date(payload.endTime);

    try {
      // Query historical data
      const history = await this.eventsTelemetry.getHistoricalData({
        startTime: start,
        endTime: end,
      });

      // Stream it back (chunked to avoid overwhelming)
      const chunkSize = 100;
      for (let i = 0; i < history.length; i += chunkSize) {
        const chunk = history.slice(i, i + chunkSize);
        const isLast = i + chunkSize >= history.length;

        client.emit(
          'replay-chunk',
          WebSocketFrameBuilder.stream('replay-data', chunk, isLast),
        );

        // Small delay to avoid backpressure
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      this.logger.error(`Replay failed for ${client.id}:`, error);
      client.emit(
        'error',
        WebSocketFrameBuilder.error('REPLAY_ERROR', error.message),
      );
    }
  }
}
```

---

## 6. Error Handling

### 6.1 Domain Exception Hierarchy

```typescript
// src/web/exceptions/web.exceptions.ts

/**
 * Base exception for WebModule.
 */
export class WebException extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'WebException';
  }
}

/**
 * Thrown when a KG query is invalid or fails.
 */
export class GraphQueryException extends WebException {
  constructor(message: string) {
    super('GRAPH_QUERY_ERROR', message, 400);
  }
}

/**
 * Thrown when EventsService returns an error.
 */
export class EventsQueryException extends WebException {
  constructor(message: string) {
    super('EVENTS_QUERY_ERROR', message, 500);
  }
}

/**
 * Thrown when DriveEngineModule returns an error.
 */
export class DriveEngineException extends WebException {
  constructor(message: string) {
    super('DRIVE_ENGINE_ERROR', message, 500);
  }
}

/**
 * Thrown when a client makes an invalid request.
 */
export class ValidationException extends WebException {
  constructor(message: string, details?: Record<string, any>) {
    super('VALIDATION_ERROR', message, 400);
    this.details = details;
  }
  details?: Record<string, any>;
}
```

### 6.2 Exception Filter Implementation

```typescript
// src/web/filters/exception.filter.ts

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';

    if (exception instanceof WebException) {
      statusCode = exception.statusCode;
      message = exception.message;
      code = exception.code;
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      message = exception.getResponse();
    }

    this.logger.error(`[${request.method} ${request.url}] ${code}: ${message}`);

    response.status(statusCode).json({
      statusCode,
      code,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
```

### 6.3 WebSocket Error Handling

```typescript
// src/web/filters/ws-exception.filter.ts

@Catch(WsException)
export class WsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger('WsExceptionFilter');

  catch(exception: WsException, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient();
    const data = host.switchToWs().getData();

    const error = exception.getError();
    let code = 'WS_ERROR';
    let message = 'Unknown error';

    if (typeof error === 'string') {
      message = error;
    } else if (error instanceof Error) {
      message = error.message;
      if (error instanceof WebException) {
        code = error.code;
      }
    }

    this.logger.error(`WS exception: ${code} - ${message}`);

    client.emit('error', {
      type: 'error',
      code,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
```

---

## 7. Configuration

### 7.1 Environment Variables

```bash
# HTTP & WebSocket Configuration
WEB_PORT=3000
WEB_HOST=0.0.0.0

# CORS Policy
CORS_ORIGIN=http://localhost:3000
CORS_CREDENTIALS=true

# WebSocket Configuration
WS_PATH_PREFIX=/ws
WS_MAX_CLIENTS=1000
WS_HEARTBEAT_INTERVAL=30000

# Security & Debug
SECURITY_DEVELOPMENT_MODE=true
SECURITY_RATE_LIMIT_WINDOW_MS=60000
SECURITY_RATE_LIMIT_MAX_REQUESTS=100
```

### 7.2 Config Service Integration

```typescript
// src/shared/config.ts (extends global config)
export interface AppConfig {
  web: {
    port: number;
    host: string;
    cors: {
      origin: string | string[];
      credentials: boolean;
    };
    websocket: {
      pathPrefix: string;
      maxClients: number;
      heartbeatInterval: number;
    };
    security: {
      developmentMode: boolean;
      rateLimit: {
        windowMs: number;
        max: number;
      };
    };
  };
  // ... other subsystems
}

export const webConfigFactory = (): AppConfig['web'] => ({
  port: parseInt(process.env.WEB_PORT || '3000', 10),
  host: process.env.WEB_HOST || '0.0.0.0',
  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(','),
    credentials: process.env.CORS_CREDENTIALS === 'true',
  },
  websocket: {
    pathPrefix: process.env.WS_PATH_PREFIX || '/ws',
    maxClients: parseInt(process.env.WS_MAX_CLIENTS || '1000', 10),
    heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000', 10),
  },
  security: {
    developmentMode: process.env.SECURITY_DEVELOPMENT_MODE === 'true',
    rateLimit: {
      windowMs: parseInt(process.env.SECURITY_RATE_LIMIT_WINDOW_MS || '60000', 10),
      max: parseInt(process.env.SECURITY_RATE_LIMIT_MAX_REQUESTS || '100', 10),
    },
  },
});
```

---

## 8. Risks & Concerns

### 8.1 Module Boundary Violations

**Risk:** WebModule mutates state in upstream modules.

**Prevention:**
- All injected services implement strict read-only interfaces.
- No write methods exposed in IEventsTelemetry, IDriveStateReader, etc.
- Controllers and gateways inherit read-only contracts in type system.
- Code review checklist: "Does WebModule ever call `.write()`, `.create()`, or `.update()` on injected services?"

### 8.2 WebSocket Backpressure

**Risk:** Rapid event emissions overwhelm clients or consume memory.

**Mitigation:**
- Use Socket.io's `emit()` with acknowledgment callbacks to detect slow clients.
- Implement flow control: if client is slow, queue events in bounded buffer (max 1000); drop oldest if exceeded.
- Add telemetry: log dropped events and slow client warnings.

```typescript
// In TelemetryGateway
private clientQueues: Map<string, any[]> = new Map();
private readonly maxQueueSize = 1000;

handleDriveTick(tick: DriveTick): void {
  for (const clientId of this.getConnectedClients()) {
    const queue = this.clientQueues.get(clientId) || [];
    if (queue.length < this.maxQueueSize) {
      queue.push(tick);
      this.clientQueues.set(clientId, queue);
    } else {
      // Queue full; drop oldest
      queue.shift();
      this.logger.warn(`Dropped event for ${clientId}; queue overflow`);
    }
  }
  this.flushQueues();
}
```

### 8.3 Security: Access Control

**Risk:** Unauthenticated clients can read sensitive internal state.

**Mitigation (Phase 1):**
- WebModule currently has no auth (development-only).
- Add `@RequireAuth()` decorator in Phase 2.
- For now, document that WebModule must run behind a reverse proxy with authentication (nginx, Envoy, etc.).

**Future considerations:**
- JWT tokens issued by authentication service.
- Per-client permissions (e.g., some users see only aggregated metrics, not raw data).

### 8.4 Data Leakage Through Provenance

**Risk:** Exposing provenance tags reveals internal architecture (SENSOR, GUARDIAN, LLM_GENERATED, INFERENCE).

**Mitigation:**
- In production, filter graph responses to show only high-confidence nodes (>0.6).
- Hide provenance unless client explicitly requests it (e.g., `?includeProvenance=true`).
- Document that provenance is a development-only diagnostic tool.

### 8.5 Drive State Race Conditions

**Risk:** Reading drive state while Drive Engine is updating it (separate process).

**Mitigation:**
- DriveEngineModule provides a thread-safe snapshot mechanism.
- WebModule always reads from snapshots, never raw state.
- Timestamp every drive state response so client knows staleness.

### 8.6 Performance: Graph Query Overload

**Risk:** Frontend sends expensive Cypher queries, blocking Neo4j.

**Mitigation:**
- Implement query timeouts (default 5s, configurable).
- Whitelist common queries; reject arbitrary Cypher.
- Add read replica for graph queries if needed (Phase 2).

```typescript
// In GraphController
@Get('query')
async queryGraph(
  @Query('query') query: string,
  @Query('params') paramsJson: string,
  @Query('limit', ParseIntPipe) limit: number = 100,
  @Query('offset', ParseIntPipe) offset: number = 0,
): Promise<GraphSnapshot> {
  // Validate and sanitize query
  if (!this.isQueryWhitelisted(query)) {
    throw new GraphQueryException('Query not in whitelist');
  }

  // Execute with timeout
  const result = await this.queryWithTimeout(query, JSON.parse(paramsJson), 5000);
  return this.serializeResult(result, limit, offset);
}
```

### 8.7 Conversation Privacy

**Risk:** Conversation history exposed to all authenticated clients.

**Mitigation:**
- Conversation endpoints return only to the guardian (for now).
- In Phase 2, implement per-user conversation filtering if needed.

### 8.8 Metrics Endpoint Exposure

**Risk:** Development metrics reveal internal algorithm details (Type 1/Type 2 ratio, drive rule parameters).

**Mitigation:**
- Metrics endpoint guarded by `@UseGuards(DevelopmentGuard)`.
- Returns `403 Forbidden` if `developmentMode !== true`.
- Never log metrics in production; they are strictly ephemeral.

---

## 9. v1 Lift Assessment

The v1 codebase in `co-being/packages/backend/src/web/` provides reference implementations. Here's what to adapt vs. rebuild:

### 9.1 What to Adapt from v1

**HealthController**
- Pattern: Simple status aggregator, non-blocking.
- Lift: Yes, refactor to async health checks per database.

**DrivesController**
- Pattern: Read current state, expose as REST. Debug endpoints for testing.
- Lift: Yes, adapt `getDriveStatus()`, `getPressure()`. Keep debug endpoints behind `DevelopmentGuard`.
- Change: Remove `postDriveOverride()`, `postDriveDrift()`, `postDriveReset()` (write operations) into separate internal API.

**GraphController**
- Pattern: `getSnapshot(paginated)`, `getStats()`.
- Lift: Yes, adapt for Neo4j. Use v1's graph serializer pattern.

**ConnectionManagerService**
- Pattern: Channel-based client registration, broadcast, per-client routing.
- Lift: Yes, but refactor from imperative Map management to cleaner interface.

**TelemetryGateway**
- Pattern: Open subscriptions on connect, emit events on receive, cleanup on disconnect.
- Lift: Partially. v1 broadcasts graph snapshots; we want finer-grained event streams (drive ticks, predictions).

**ConversationGateway**
- Pattern: Handle `handleRawMessage()`, emit responses.
- Lift: Yes, but split into separate `ConversationController` (REST) + `ConversationGateway` (WebSocket).

### 9.2 What to Rebuild Clean-Room

**Error Handling**
- v1 may not have fine-grained exception hierarchy.
- Rebuild: WebException, GraphQueryException, EventsQueryException with proper HTTP status mapping.

**Interceptors & Filters**
- v1 likely minimal.
- Rebuild: ErrorMappingInterceptor, WsExceptionFilter, LoggingInterceptor for proper cross-cutting concerns.

**Guards**
- v1 may lack DevelopmentGuard for feature gating.
- Rebuild: DevelopmentGuard, QueryGuard, and prepare for future auth.

**DTOs**
- v1 may have inline response types.
- Rebuild: Explicit DTOs with `@Expose()` decorators for serialization control.

**WebSocket Message Framing**
- v1 may use ad-hoc message formats.
- Rebuild: Standardized WebSocketMessage with type, event, payload, timestamp, sequence.

---

## 10. Suggested Implementation Sequence

### Phase 9a: Infrastructure (2-3 days)
1. Create WebModule skeleton with configuration.
2. Implement ConnectionManagerService (minimal).
3. Add global ExceptionFilter and WsExceptionFilter.
4. Add DevelopmentGuard for feature gating.

### Phase 9b: Controllers (2-3 days)
5. HealthController with database ping logic.
6. DrivesController with drive state + history.
7. GraphController with paginated snapshot + stats.
8. ConversationController with history retrieval.
9. MetricsController (skeleton; implement metrics aggregation logic).

### Phase 9c: WebSocket Gateways (2-3 days)
10. TelemetryGateway with drive tick + action + prediction streams.
11. GraphUpdatesGateway (optional Phase 1; can defer to Phase 2 if time-constrained).
12. ConversationGateway (text-only; voice integration in E6).

### Phase 9d: Integration & Testing (1-2 days)
13. Register all controllers and gateways in WebModule.
14. Test all endpoints with Postman / Thunder Client.
15. Test WebSocket connections with socket.io client library.
16. Verify error handling and status codes.

---

## 11. Key Technical Patterns Summary

| Pattern | Usage | Files |
|---------|-------|-------|
| **Controller** | Read-only REST endpoints | `controllers/*.controller.ts` |
| **Gateway** | WebSocket dual-mode (inbound RPC + outbound streams) | `gateways/*.gateway.ts` |
| **Guard** | Enforce preconditions (auth, development mode) | `guards/*.guard.ts` |
| **Interceptor** | Cross-cutting concerns (logging, error mapping) | `interceptors/*.interceptor.ts` |
| **Filter** | Exception handler (HTTP + WS) | `filters/*.filter.ts` |
| **DTO** | Serializable response shape with `@Expose()` | `dtos/*.dto.ts` |
| **Service** | Delegate to subsystem interfaces | Internal to controllers/gateways |
| **Injection Token** | Symbol for DI | `interfaces/web.tokens.ts` |
| **Custom Exception** | Domain-specific errors | `exceptions/web.exceptions.ts` |

---

## 12. Verification Checklist

Before code review:

- [ ] No write methods called on injected services
- [ ] All HTTP responses use explicit status codes
- [ ] All WebSocket messages use standardized frame format
- [ ] Exception filter catches all exception types
- [ ] DevelopmentGuard blocks sensitive endpoints in production
- [ ] Configuration loaded via ConfigService, not hardcoded
- [ ] DTOs use `@Expose()` for field control
- [ ] Error responses never leak sensitive details
- [ ] WebSocket client registration/unregistration is clean (no memory leaks)
- [ ] All dependencies declared in imports array
- [ ] No circular dependencies between modules
- [ ] Type-checking passes: `npx tsc --noEmit`

---

## 13. Architectural Constraints Enforced

1. **Isolation Principle:** WebModule never mutates drive state, knowledge graph, or event store. It reads; others write.
2. **Theater Prohibition:** Drive state passed to frontend accurately reflects actual state (no synthetic emotions).
3. **Confidence Ceiling:** No knowledge shown on frontend exceeds 0.60 without usage evidence (filtered server-side if needed).
4. **Read-Only Access:** All injected services implement read-only interfaces; compile-time contract.
5. **Error Transparency:** Exceptions map cleanly to HTTP/WebSocket frames; no raw stack traces in responses.
6. **Configuration-First:** All behavior configurable via environment; no magic values.

---

## Appendix A: Example Health Check Sequence

```
1. Client: GET /health
2. HealthController.getHealth()
   → calls HealthService.getHealthStatus()
3. HealthService checks:
   - Neo4j: ping via KnowledgeModule
   - TimescaleDB: ping via EventsModule
   - PostgreSQL: ping via DriveEngineModule
   - Grafeo (Self KG): ping via KnowledgeModule
   - Grafeo (Other KGs): ping via KnowledgeModule
4. HealthCheckResponse:
   {
     "status": "healthy",
     "timestamp": "2026-03-29T14:23:05Z",
     "databases": [
       { "name": "neo4j", "connected": true, "latency": 2, "lastChecked": "..." },
       { "name": "timescaledb", "connected": true, "latency": 5, "lastChecked": "..." },
       ...
     ],
     "subsystems": {
       "decision-making": { "status": "ready" },
       "communication": { "status": "ready" },
       ...
     }
   }
5. Client receives 200 OK + JSON body
```

---

## Appendix B: Example WebSocket Connection Sequence (Telemetry)

```
1. Client: ws://localhost:3000/ws/telemetry
2. TelemetryGateway.handleConnection(client)
   → registers client in ConnectionManager
   → sends 'drive-snapshot' with current state
   → opens subscriptions to EventsTelemetry
3. Client receives:
   {
     "type": "event",
     "event": "drive-snapshot",
     "payload": { "drives": {...}, "timestamp": "..." },
     "timestamp": "..."
   }
4. Drive tick occurs in DriveEngine
5. EventsTelemetry emits tick → TelemetryGateway broadcasts
6. Client receives:
   {
     "type": "stream",
     "event": "drive-tick",
     "payload": { "drives": {...}, "timestamp": "..." },
     "timestamp": "...",
     "sequence": 1
   }
7. Client disconnects
8. TelemetryGateway.handleDisconnect(client)
   → unregisters client
   → cleanup subscriptions
9. Server closes connection gracefully
```

