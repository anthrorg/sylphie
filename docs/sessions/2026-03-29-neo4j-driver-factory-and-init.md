# 2026-03-29 -- Neo4j driver factory provider and constraint setup (E1-T003)

## Changes
- NEW: `src/knowledge/neo4j-init.service.ts` -- Neo4j initialization service with OnModuleInit/Destroy, idempotent constraint setup, index creation, schema bootstrap, and health check method
- MODIFIED: `src/knowledge/knowledge.module.ts` -- Replaced null NEO4J_DRIVER factory with real driver creation using ConfigService, registered Neo4jInitService as provider

## Wiring Changes
- NEO4J_DRIVER factory now injects ConfigService to read appConfig.neo4j (uri, user, password, maxConnectionPoolSize, connectionTimeoutMs)
- Driver created with neo4j.driver() and connection pooling enabled
- Neo4jInitService runs onModuleInit after driver creation to set up constraints and schema
- Neo4jInitService runs onModuleDestroy to gracefully close driver on shutdown

## Known Issues
- None. All functionality implemented: constraints, indexes, schema bootstrap, health check

## Gotchas for Next Session
- Driver creation may fail if ConfigService is not properly initialized before KnowledgeModule loads
- Neo4j constraints require the correct Cypher syntax for your Neo4j version (4.x+ tested)
- SHOW CONSTRAINTS query in healthCheck may behave differently across Neo4j versions
