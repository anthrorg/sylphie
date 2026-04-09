import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import neo4j, { Driver, Session } from 'neo4j-driver';
import {
  NEO4J_INSTANCE_CONFIG,
  Neo4jModuleConfig,
  Neo4jInstanceName,
} from './neo4j.constants';

@Injectable()
export class Neo4jService implements OnModuleInit, OnModuleDestroy {
  private readonly drivers = new Map<Neo4jInstanceName, Driver>();
  private readonly logger = new Logger(Neo4jService.name);

  constructor(
    @Inject(NEO4J_INSTANCE_CONFIG) private config: Neo4jModuleConfig,
  ) {
    for (const instance of config.instances) {
      const driver = neo4j.driver(
        instance.uri,
        neo4j.auth.basic(instance.user, instance.password),
        {
          maxConnectionPoolSize: instance.maxConnectionPoolSize,
          connectionTimeout: instance.connectionTimeoutMs,
        },
      );
      this.drivers.set(instance.name, driver);
    }
  }

  async onModuleInit() {
    for (const [name, driver] of this.drivers) {
      try {
        await this.connectWithRetry(name, driver);
      } catch (err) {
        this.logger.error(
          `Failed to connect to Neo4j [${name}] after retries: ${
            err instanceof Error ? err.message : String(err)
          }. Service will attempt lazy reconnection.`,
        );
      }
    }
  }

  private async connectWithRetry(
    name: Neo4jInstanceName,
    driver: Driver,
    retries = 5,
    delayMs = 3000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await driver.verifyConnectivity();
        this.logger.log(`Connected to Neo4j [${name}]`);
        return;
      } catch (err) {
        if (attempt === retries) throw err;
        this.logger.warn(
          `Neo4j [${name}] not ready (attempt ${attempt}/${retries}), retrying in ${delayMs / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async onModuleDestroy() {
    await Promise.all(
      Array.from(this.drivers.entries()).map(async ([name, driver]) => {
        await driver.close();
        this.logger.log(`Disconnected from Neo4j [${name}]`);
      }),
    );
  }

  getDriver(name: Neo4jInstanceName): Driver {
    const driver = this.drivers.get(name);
    if (!driver) {
      throw new Error(`Neo4j driver '${name}' not configured`);
    }
    return driver;
  }

  getSession(
    name: Neo4jInstanceName,
    mode: 'READ' | 'WRITE' = 'WRITE',
  ): Session {
    const driver = this.getDriver(name);
    const instance = this.config.instances.find((i) => i.name === name);
    return driver.session({
      database: instance?.database ?? 'neo4j',
      defaultAccessMode:
        mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
    });
  }
}
