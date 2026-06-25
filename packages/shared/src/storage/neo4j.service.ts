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

/**
 * Return a loggable summary of a Neo4j URI: scheme + host, no credentials.
 * Used at driver-creation time so boot logs show exactly what is being
 * attempted — the primary diagnostic for URI/encryption mismatches.
 */
function uriSummary(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.hostname}:${u.port || '(default)'}`;
  } catch {
    return uri ?? '(undefined)';
  }
}

@Injectable()
export class Neo4jService implements OnModuleInit, OnModuleDestroy {
  private readonly drivers = new Map<Neo4jInstanceName, Driver>();
  private readonly logger = new Logger(Neo4jService.name);

  constructor(
    @Inject(NEO4J_INSTANCE_CONFIG) private config: Neo4jModuleConfig,
  ) {
    for (const instance of config.instances) {
      // Validate required env vars before handing them to the driver.
      // A missing URI produces a confusing "encryption mismatch" error from the
      // driver (Neo4j 4.0 default-encryption change); catching it here gives a
      // clear error that names the missing variable and the instance.
      if (!instance.uri || !instance.user || !instance.password) {
        this.logger.error(
          `Neo4j [${instance.name}] misconfigured — uri="${instance.uri ?? '(missing)'}" ` +
            `user="${instance.user ?? '(missing)'}" password=${instance.password ? '(set)' : '(missing)'}. ` +
            `Set NEO4J_${instance.name.toUpperCase()}_URI / _USER / _PASSWORD env vars.`,
        );
      }

      // Log the URI scheme+host at creation so boot logs show what is being
      // attempted. Password is never logged.
      this.logger.log(
        `Neo4j [${instance.name}] driver: ${uriSummary(instance.uri)} ` +
          `(pool=${instance.maxConnectionPoolSize}, timeout=${instance.connectionTimeoutMs}ms)`,
      );

      // Explicitly set encrypted=false for bolt:// / neo4j:// URIs to prevent
      // the Neo4j 4.0 encryption-by-default ambiguity: on Railway private
      // networking the bolt port (7687) is plain-text; a driver that silently
      // attempts TLS handshake on a plain-text port produces the same
      // "Failed to connect" error as a wrong URI. For encrypted endpoints use
      // bolt+s:// or neo4j+s:// — the +s suffix is the authoritative signal.
      const scheme = instance.uri?.split('://')[0] ?? '';
      const usePlaintext = scheme === 'bolt' || scheme === 'neo4j';

      const driver = neo4j.driver(
        instance.uri,
        neo4j.auth.basic(instance.user, instance.password),
        {
          maxConnectionPoolSize: instance.maxConnectionPoolSize,
          connectionTimeout: instance.connectionTimeoutMs,
          // Suppress encryption for plain-text schemes. Encrypted schemes
          // (bolt+s, neo4j+s, bolt+ssc, neo4j+ssc) carry the signal in the
          // URI itself; encrypted:false would be ignored for those anyway.
          ...(usePlaintext ? { encrypted: false } : {}),
        },
      );
      this.drivers.set(instance.name, driver);
    }
  }

  async onModuleInit() {
    for (const [name, driver] of this.drivers) {
      const instanceCfg = this.config.instances.find((i) => i.name === name);
      try {
        await this.connectWithRetry(name, driver);
      } catch (err) {
        // Include the URI in the error so the operator can immediately see
        // whether the wrong scheme/host/port is the cause without grepping
        // env var dumps. Password is never included.
        this.logger.error(
          `Failed to connect to Neo4j [${name}] after retries ` +
            `(uri=${uriSummary(instanceCfg?.uri ?? '')}): ${
              err instanceof Error ? err.message : String(err)
            }. Check NEO4J_${name.toUpperCase()}_URI / _USER / _PASSWORD env vars and ` +
            `that the service is reachable from this host. ` +
            `For Railway private networking use bolt:// with port 7687.`,
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
