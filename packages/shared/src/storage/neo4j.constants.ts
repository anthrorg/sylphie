export const NEO4J_INSTANCE_CONFIG = 'NEO4J_INSTANCE_CONFIG';

export enum Neo4jInstanceName {
  WORLD = 'world',
  SELF = 'self',
  OTHER = 'other',
  PKG = 'pkg',
}

export interface Neo4jInstanceConfig {
  name: Neo4jInstanceName;
  uri: string;
  user: string;
  password: string;
  database: string;
  maxConnectionPoolSize: number;
  connectionTimeoutMs: number;
}

export interface Neo4jModuleConfig {
  instances: Neo4jInstanceConfig[];
}
