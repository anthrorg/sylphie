import { Global, Module, DynamicModule } from '@nestjs/common';
import { NEO4J_INSTANCE_CONFIG, Neo4jModuleConfig } from './neo4j.constants';
import { Neo4jService } from './neo4j.service';

@Global()
@Module({})
export class Neo4jModule {
  static forRoot(config: Neo4jModuleConfig): DynamicModule {
    return {
      module: Neo4jModule,
      global: true,
      providers: [
        { provide: NEO4J_INSTANCE_CONFIG, useValue: config },
        Neo4jService,
      ],
      exports: [Neo4jService],
    };
  }

  static forRootAsync(options: {
    imports?: any[];
    useFactory: (
      ...args: any[]
    ) => Neo4jModuleConfig | Promise<Neo4jModuleConfig>;
    inject?: any[];
  }): DynamicModule {
    return {
      module: Neo4jModule,
      global: true,
      imports: options.imports || [],
      providers: [
        {
          provide: NEO4J_INSTANCE_CONFIG,
          useFactory: options.useFactory,
          inject: options.inject || [],
        },
        Neo4jService,
      ],
      exports: [Neo4jService],
    };
  }
}
