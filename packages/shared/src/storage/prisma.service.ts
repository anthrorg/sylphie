import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

export interface PostgresRuntimeConfig {
  runtimeUser: string;
  runtimePassword: string;
  host: string;
  port: number;
  database: string;
}

/**
 * TK-150 (item 20260702-005): the user/password go into the URL's authority
 * section, where `:`, `@`, `/`, `#`, `%`, etc. are structurally significant.
 * An unescaped special character in either (e.g. a generated password
 * containing `@`) silently splits the URL wrong — Prisma would parse a
 * garbled host or database name instead of failing loudly, since it just
 * sees a differently-shaped (but syntactically valid) connection string.
 * Exported standalone so it's unit-testable without booting a real Prisma
 * client.
 */
export function buildPostgresUrl(pg: PostgresRuntimeConfig): string {
  const user = encodeURIComponent(pg.runtimeUser);
  const password = encodeURIComponent(pg.runtimePassword);
  return `postgresql://${user}:${password}@${pg.host}:${pg.port}/${pg.database}`;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(private configService: ConfigService) {
    const pg = configService.get('postgres')!;
    const url = buildPostgresUrl(pg);

    super({
      datasources: { db: { url } },
      log:
        configService.get('APP_ENV') === 'development'
          ? ['warn', 'error']
          : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.$connect();
        this.logger.log('Connected to PostgreSQL');
        return;
      } catch (err) {
        if (attempt === 5) {
          this.logger.error(
            `Failed to connect to PostgreSQL after 5 attempts: ${
              err instanceof Error ? err.message : String(err)
            }. Queries will fail until the database becomes available.`,
          );
          return;
        }
        this.logger.warn(
          `PostgreSQL not ready (attempt ${attempt}/5), retrying in 3s...`,
        );
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Disconnected from PostgreSQL');
  }
}
