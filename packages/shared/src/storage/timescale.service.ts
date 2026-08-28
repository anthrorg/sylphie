import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class TimescaleService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly logger = new Logger(TimescaleService.name);

  constructor(private configService: ConfigService) {
    const cfg = this.configService.get('timescale')!;
    this.pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      max: cfg.maxConnections,
      idleTimeoutMillis: cfg.idleTimeoutMs,
      connectionTimeoutMillis: cfg.connectionTimeoutMs,
    });
  }

  async onModuleInit() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const client = await this.pool.connect();
        try {
          await client.query('SELECT 1');
          this.logger.log('Connected to TimescaleDB');
          return;
        } finally {
          client.release();
        }
      } catch (err) {
        if (attempt === 5) {
          this.logger.error(
            `Failed to connect to TimescaleDB after 5 attempts: ${
              err instanceof Error ? err.message : String(err)
            }. Queries will fail until the database becomes available.`,
          );
          return;
        }
        this.logger.warn(
          `TimescaleDB not ready (attempt ${attempt}/5), retrying in 3s...`,
        );
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
    this.logger.log('Disconnected from TimescaleDB');
  }

  async query<T extends QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      // TK-151 (item 20260702-005): if the ROLLBACK query itself throws
      // (e.g. the connection dropped), the un-awaited-around-a-try
      // `await client.query('ROLLBACK')` would replace `e` — the caller
      // would see the ROLLBACK failure instead of the ORIGINAL error that
      // triggered the rollback in the first place, masking the real cause.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.error(
          `ROLLBACK failed while handling a transaction error: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
        );
      }
      throw e;
    } finally {
      client.release();
    }
  }
}
