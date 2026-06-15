# sylphie-pkg — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**20 files** mapped.

## File-by-file

### `packages/sylphie-pkg/src/ingestion/`

#### backfill-changes.ts
*service* — One-shot backfill service that creates Change nodes from git history and wires CHANGED_IN edges to Functions/Types in affected files.

Reads the last 30 commits from git log, creates a Change node per commit with hash, shortHash, author, date, message, fileCount, and recordedAt timestamp. For each commit, queries changed files via git diff (with fallback to git show), then wires CHANGED_IN edges from any Function or Type node whose filePath matches the touched files. Idempotent: skips commits where Change node already exists. Uses Neo4j constraint on Change.hash for uniqueness. Entry point is npm run backfill-changes. Normalizes Windows backslashes to forward slashes for path matching.

- **Key constants:** `REPO_ROOT=process.cwd()`, `NEO4J_URI=bolt://localhost:7691 (env SYLPHIE_PKG_NEO4J_URI)`, `NEO4J_USER=neo4j (env)`, `NEO4J_PASSWORD=sylphie-pkg-local (env)`, `COMMIT_LIMIT=30`
- **Deps:** `neo4j-driver`, `child_process`
- **Gotchas:** No error if getChangedFiles fails on a commit — warns and skips edges for that commit. Neo4j constraint created IF NOT EXISTS on each run (safe but redundant). Path normalization strips backslashes for both local filePath matching and parameter passing, may mask platform-specific bugs. No validation that Function/Type nodes exist before wiring edges.

#### initial-seed.ts
*service* — One-time monorepo TypeScript AST parse and PKG graph bootstrap that populates Neo4j with code structure and relationships.

Walks all 5 watched packages (app, shared, decision-making, drive-engine, frontend) to discover .ts/.tsx files, parsing functions/types/imports via ast-parser and batch-writing 50 files at a time to Neo4j. Creates schema indexes and constraints on Service/Module/Function/Type/File nodes, builds edges for IMPORTS (module-level), CALLS (function-to-function), USES_TYPE, EXTENDS, IMPLEMENTS, and INJECTS (constructor injection). Excludes node_modules, dist, .d.ts, and test files. Resolves @sylphie/* workspace imports and relative imports via resolveImportTarget(). Batches size = 50; max code body slice = 8000 chars. Runs integrity checks at the end and records final commit SHA to .last-sync-commit for delta tracking.

- **Exports:** `runSeed`
- **Key constants:** `BATCH_SIZE=50`, `WATCHED_PACKAGES=[app,shared,decision-making,drive-engine,frontend]`, `EXCLUDE_PATTERNS=[node_modules,/dist/,.d.ts,.spec.ts,.test.ts,.spec.tsx,.test.tsx]`, `PACKAGE_SOURCE_DIRS={@sylphie/shared,@sylphie/decision-making,@sylphie/drive-engine}`
- **Deps:** `../sync/ast-parser.js`, `../sync/integrity-checker.js`, `../sync/git-diff.js`, `../mcp-server/neo4j-client.js`
- **Gotchas:** CALLS/USES_TYPE/EXTENDS/IMPLEMENTS edge creation uses silent catch blocks (skip unresolvable) — failed edges are not reported; constructor param injection filter skips unknown types or names > 80 chars; batch transaction rollback only logs stderr warning, does not fail the seed; no explicit check for duplicate nodes before MERGE (relies on Neo4j MERGE semantics).

#### manual-constraints.ts
*util* — CLI tool for ingesting constraint definitions into the PKG via Neo4j, linking them to Module/Function/Service nodes.

Exports validateConstraint() to validate individual constraint objects against required fields (id, description, scope, scopeType, source, severity) with enum validation for severity (must|should|prefer) and scopeType (module|function|service). loadConstraints() reads and parses a constraints.json array file with validation. buildScopeMatch() generates Cypher MATCH clauses and parameters for three scope types: service (by name), module (by filePath prefix), function (by filePath::functionName syntax). writeConstraint() uses Neo4j transactions to MERGE Constraint nodes, SET properties, then MERGE CONSTRAINED_BY edges from target nodes to constraints, returning linked count. runAddConstraints() is the main orchestrator: loads constraints, prints summaries, optionally validates-only, or writes all constraints with error collection and exit(1) on failures. Entry point checks fileURLToPath for direct script execution, parsing --validate flag and optional file path argument (default: packages/sylphie-pkg/constraints.json).

- **Exports:** `ConstraintSeverity`, `ConstraintScopeType`, `ConstraintDefinition`, `validateConstraint`, `loadConstraints`, `runAddConstraints`
- **Key constants:** `REPO_ROOT=process.cwd()`, `DEFAULT_CONSTRAINTS_FILE=packages/sylphie-pkg/constraints.json`
- **Deps:** `../mcp-server/neo4j-client.js (getDriver, closeDriver)`
- **Gotchas:** Function-scoped constraints require filePath::functionName format (no validation if missing ::). Module scope with relative paths auto-resolves to absolute; service scope normalizes \\ to /. MERGE Constraint always succeeds even if target node match fails (linked=0) — warning logged but no error thrown, could mask missing seed data. Tags defaulted to ['general'] if empty array. Neo4j integer conversion via .toNumber() for compatibility.

### `packages/sylphie-pkg/src/mcp-server/`

#### index.ts
*service* — MCP server entry point that exposes 7 tools for querying codebase structure from a Neo4j graph

Registers and dispatches 7 MCP tools: getModuleContext (module overview), getFunctionDetail (function body+types+tests+history), getDataFlow (trace data connections upstream/downstream up to 6 hops), getRecentChanges (cross-reference concept with git/PR history since default 30 days), getConstraints (architectural invariants for scope), getLogContext (query disk log files by pattern/service/severity/date), searchContent (regex search in function/type bodies with structured results). Each tool validates inputs and returns text via CallToolRequest dispatch. Server runs on stdio transport (node dist/mcp-server/index.js) and connects Neo4j client that must be at bolt://localhost:7691. Graceful shutdown on SIGINT/SIGTERM/disconnect closes Neo4j driver.

- **Exports:** `(implicit: MCP server via stdio, tools named in TOOLS array)`
- **Key constants:** `server name=sylphie-pkg`, `server version=0.1.0`, `default getDataFlow depth=3, max 6`, `default getRecentChanges since=30 days ago`, `default getLogContext since=7 days ago`, `default searchContent maxResults=20, max 50`, `neo4j endpoint=bolt://localhost:7691`
- **Deps:** `@modelcontextprotocol/sdk/server`, `@modelcontextprotocol/sdk/server/stdio.js`, `./neo4j-client.js`, `./tools/getModuleContext.js`, `./tools/getFunctionDetail.js`, `./tools/getDataFlow.js`, `./tools/getRecentChanges.js`, `./tools/getConstraints.js`, `./tools/getLogContext.js`, `./tools/searchContent.js`
- **Gotchas:** Error handler mentions bolt://localhost:7691 hardcoded in error message; relies on external Neo4j service running; all tool handlers are async and can fail; no validation that handlers actually exist before dispatch (relies on import side-effects).

#### neo4j-client.ts
*service* — Singleton Neo4j connection manager for the sylphie-pkg MCP server

Manages a singleton neo4j-driver instance connected to the dedicated sylphie-pkg Neo4j instance (bolt://localhost:7691, separate from main WKG instance on 7687). Exports three functions: getDriver() creates/returns the singleton driver on first call with maxConnectionPoolSize=10 and connectionAcquisitionTimeout=5000; closeDriver() closes the driver and nullifies the reference; runQuery(cypher, params) opens a READ-mode session, executes the Cypher query with optional parameters, returns Neo4jRecord[], and closes the session. Errors are caught and wrapped with query preview (first 200 chars). Logging configured to warn level, outputting errors/warnings to stderr.

- **Exports:** `getDriver`, `closeDriver`, `runQuery`
- **Key constants:** `NEO4J_URI=bolt://localhost:7691 (env override: SYLPHIE_PKG_NEO4J_URI)`, `NEO4J_USER=neo4j (env override: SYLPHIE_PKG_NEO4J_USER)`, `NEO4J_PASSWORD=sylphie-pkg-local (env override: SYLPHIE_PKG_NEO4J_PASSWORD)`, `maxConnectionPoolSize=10`, `connectionAcquisitionTimeout=5000`, `logging.level=warn`
- **Deps:** `neo4j`

### `packages/sylphie-pkg/src/mcp-server/tools/`

#### getConstraints.ts
*service* — MCP tool that retrieves architectural constraints from PKG matching a scope query

Exports handleGetConstraints() which takes a scope string (service/module/function name) and queries Neo4j via runQuery() to find Constraint nodes. Executes two queries: (1) CONSTRAINED_BY edges from nodes matching scope pattern, (2) direct Constraint nodes with matching name/area. Results are deduplicated by description and grouped by severity (critical→high→medium→low→unknown). Returns formatted text output listing constraints with owner/area/source metadata, max 30 linked + 10 direct constraints. Helper escapeRegex() escapes special regex characters in search term. All severity levels hardcoded: critical=0, high=1, medium=2, low=3, else=4 for sort order.

- **Exports:** `handleGetConstraints`, `GetConstraintsInput`, `escapeRegex`
- **Key constants:** `LIMIT linked=30`, `LIMIT direct=10`, `severity sort: critical=0, high=1, medium=2, low=3, else=4`
- **Deps:** `../neo4j-client.js (runQuery)`
- **Gotchas:** No validation of scope input; relies on regex matching which could be slow on large graphs. Suggests checking docs/CANON.md when no constraints found (manual fallback, not automatic). Deduplication by description string may miss semantically identical constraints with slightly different wording.

#### getDataFlow.ts
*service* — MCP tool handler that traces upstream/downstream data dependencies from a named function/type node via Neo4j graph traversal.

Exports handleGetDataFlow() to accept a start node name, direction (upstream|downstream|both), and optional depth; queries Neo4j to locate the start node (matching Function or Type), then calls traceDirection() to traverse edges (CALLS, USES_TYPE, IMPORTS, CONTAINS, INJECTS, EXTENDS, IMPLEMENTS) up to MAX_DEPTH=6. Builds human-readable output showing hop-distance-grouped results with file paths, labels, return types, and kinds. Falls back to ENDS WITH suffix matching for unqualified method names. Enforces depth=min(input.depth, 6) to bound query cost. Target response size 1000-3000 tokens. Zero side effects: read-only Neo4j queries only.

- **Exports:** `handleGetDataFlow`, `GetDataFlowInput`
- **Key constants:** `DEFAULT_DEPTH=3`, `MAX_DEPTH=6`
- **Deps:** `../neo4j-client.js`
- **Gotchas:** Depth clamped to 6 to avoid expensive graph traversals; uses LIMIT 50 on results to cap output; multiple start-node matches return warning but proceed with first match; relies on Neo4j PKG having Function/Type nodes with CALLS\|USES_TYPE\|IMPORTS\|CONTAINS\|INJECTS\|EXTENDS\|IMPLEMENTS edges populated correctly

#### getFunctionDetail.ts
*service* — MCP tool handler that retrieves full function details including signature, body, types, tests, and recent changes from the PKG graph database.

Exports handleGetFunctionDetail() async function that queries Neo4j for a function node by name (with optional filePath filter). Two-stage lookup: exact match first, then unqualified method-name fallback (e.g., "ClassName.method"). Returns formatted text output with function signature (export/async prefixes, args, return type), file location, JSDoc comment, full body text, linked Type nodes (up to 20), related test files (up to 10), and recent Change nodes (up to 5, ordered by date DESC). Handles zero/multiple matches with helpful error messages. Target response size 500-2000 tokens.

- **Exports:** `GetFunctionDetailInput`, `handleGetFunctionDetail`
- **Key constants:** `LIMIT 5 (functions)`, `LIMIT 20 (types)`, `LIMIT 10 (test files)`, `LIMIT 5 (changes)`
- **Deps:** `runQuery from ../neo4j-client.js`
- **Gotchas:** Body text may not be stored in PKG (falls back to message "body not stored"). Multi-match disambiguation requires filePath re-query. Class methods stored as "ClassName.methodName" (not obvious from error message alone). Date slicing assumes ISO format (date.slice(0,10)).

#### getLogContext.ts
*service* — MCP tool to search log files on disk matching query, service, severity, and time filters

Exports handleGetLogContext() which reads NestJS winston log files from logs/ directory and searches for matching entries using regex filters (query text, service name in brackets, severity level). Returns the last 20 matching lines with file path and line number, formatted with relative paths. Key helpers: searchFile() streams log files with readline and applies all filters; extractServiceToken() and extractSeverity() parse [SERVICE] and LEVEL: tokens from log lines; defaultSince() returns 7-day lookback date (YYYY-MM-DD); escapeRegex() safely escapes user input for regex. Constants: MAX_RESULTS=20, target response 500-2000 tokens, expected filename pattern combined-YYYY-MM-DD.log or error-YYYY-MM-DD.log. Streaming search with early exit for files/lines before sincePrefix date. No DB/network/graph writes—read-only log introspection.

- **Exports:** `handleGetLogContext`, `GetLogContextInput`
- **Key constants:** `MAX_RESULTS=20`, `LOGS_DIR=path.join(process.cwd(), 'logs')`, `default since window=7 days`
- **Deps:** `fs`, `path`, `readline`
- **Gotchas:** Assumes NestJS winston format with ISO date prefix; log format parsing via regex may fail silently if logs differ; no validation of 'since' input format—bare date comparison assumes YYYY-MM-DD; early file date skip may miss logs if filename doesn't match pattern; readline crlfDelay:Infinity handles CRLF but untested on Windows (likely works)

#### getModuleContext.ts
*service* — MCP tool handler for querying module context by name, domain, service, or function

Exports handleGetModuleContext(input: GetModuleContextInput): Promise<string>, which queries a Neo4j knowledge graph to find modules matching a user query. Search strategy uses OR-matching across module name/domain/description/packageName, service names, and function names (in order). Returns structured text with matched modules (name, service, package, domain, description, path), contained functions (up to 60), types (up to 40), and constraints (up to 20). Helper escapeRegex() safely escapes regex special characters. Target response size 1,000-3,000 tokens. Function bodies excluded; getFunctionDetail recommended for deep inspection.

- **Exports:** `handleGetModuleContext`, `GetModuleContextInput`
- **Deps:** `../neo4j-client.js`
- **Gotchas:** LIMIT 60 on functions, LIMIT 40 on types, LIMIT 20 on constraints — may truncate large modules; no pagination mechanism; regex pattern is case-insensitive (?i) and matches anywhere in field (.*pattern.*)

#### getRecentChanges.ts
*service* — MCP tool handler that queries git change history and returns affected functions/types for a given query area.

Exports handleGetRecentChanges() async function that accepts a query string (and optional since date) and searches neo4j for matching Change nodes using regex. Retrieves up to 15 changes ordered by date DESC, then performs two parallel queries to find affected functions (limit 100) and affected types (limit 50) linked via CHANGED_IN edges. Builds Maps keyed by changeId to group results, formats into readable text output showing date, author, description, and affected entities (with truncation at 10 functions, 5 types). Helper functions: defaultSince() returns ISO date 30 days ago (hardcoded -30 days), escapeRegex() escapes regex metacharacters. Response designed for 500-1500 token output.

- **Exports:** `handleGetRecentChanges`, `GetRecentChangesInput`
- **Key constants:** `CHANGE_LIMIT=15`, `FUNCTION_LIMIT=100`, `TYPE_LIMIT=50`, `FN_DISPLAY_MAX=10`, `TYPE_DISPLAY_MAX=5`, `DEFAULT_SINCE_DAYS=-30`, `HEADER_WIDTH=60`, `DIVIDER_WIDTH=50`
- **Deps:** `../neo4j-client.js via runQuery`
- **Gotchas:** No explicit null checks on runQuery results; assumes neo4j client returns valid records. Truncation of functions at 10 and types at 5 is hardcoded (lines 127, 136); regex search is case-insensitive (?i). Date filtering allows NULL since (line 30), treating it as unlimited lookback. No pagination for large result sets beyond limits.

#### searchContent.ts
*service* — MCP tool: search function/type source code in PKG via regex pattern matching on CodeBlock nodes

Exports handleSearchContent() which accepts pattern, fileFilter, and maxResults (capped at 50). Primary query traverses parent-[:HAS_CODE]->CodeBlock edges to find functions/types with matching bodyText; fallback searches old-style bodyText on Function nodes directly. Returns formatted text with matched function/type metadata (name, file, line range, async/export flags, return type) plus up to 5 matching code lines per result. Case-insensitive regex matching via escapeRegex() utility. Max response ~500-3000 tokens per docstring.

- **Exports:** `SearchContentInput`, `handleSearchContent`
- **Key constants:** `maxResults cap=50`, `matchingLines limit per result=5`, `response target size=500-3000 tokens`
- **Deps:** `neo4j-client:runQuery`
- **Gotchas:** Fallback query only runs if primary CodeBlock query returns zero results; bodyText on Function nodes is legacy pattern; no handling of multiline bodyText edge cases beyond naive split('\n')

### `packages/sylphie-pkg/src/sync/`

#### ast-parser.ts
*util* — TypeScript AST extraction layer using ts-morph for the sync pipeline to detect code changes and populate the PKG

Core public API: parseFiles(filePaths) and parseFile(filePath) extract structured metadata from TS source. Internal extraction functions handle functions (named, arrow, expressions, methods), types (interfaces, aliases, enums, classes), and imports. Key helpers: sha256() hashes node text for contentHash (16-char truncation); extractJsDoc() pulls JSDoc comments; extractBodyText() captures method/function bodies (capped at 8000 chars); extractCallees() traverses body descendants to find call expressions, filtering console/Math/JSON/Array/Promise/built-ins; extractTypeRefs() regex-matches capitalized identifiers in args/return types against BUILTIN_TYPES set. HTTP decorators (Get, Post, Put, Patch, Delete, Head, Options, All) mapped to verbs; Controller decorator extracts route prefixes. Classes capture extends/implements, constructor params with @Inject tokens. Project caching (getProject, _projectCache) maintains ts-morph Project instances per tsconfig or default. findTsConfig() walks directory tree from file location up to REPO_ROOT to locate tsconfig.json. Body text slicing and call-expression length cap (>80 chars filtered) limit metadata bloat.

- **Exports:** `parseFiles`, `parseFile`, `clearProjectCache`, `ParsedArgument`, `ParsedDecorator`, `ParsedFunction`, `ParsedProperty`, `ParsedConstructorParam`, `ParsedType`, `ParsedImport`, `ParsedFile`
- **Key constants:** `REPO_ROOT=process.cwd()`, `HTTP_DECORATORS (Get->GET, Post->POST, Put->PUT, Patch->PATCH, Delete->DELETE, Head->HEAD, Options->OPTIONS, All->ALL)`, `BUILTIN_TYPES set (Array, Map, Set, Record, Promise, Partial, Required, Readonly, Pick, Omit, React, Element, etc.)`, `extractBodyText cap=8000 chars`, `contentHash sha256 truncated to 16 chars`, `callee length filter >80 chars`
- **Deps:** `ts-morph`, `path`, `fs`, `crypto`
- **Gotchas:** No error recovery for malformed AST; extractCallees filters calls >80 chars (may hide long-form callees); decorator extraction silently catches errors (skips); parseFiles writes to stderr on error but does not throw, returns partial results; ts-morph Project caching assumes tsconfig stability across calls

#### change-logger.ts
*service* — Records Change nodes in the PKG graph for git commits and links CHANGED_IN edges from modified Functions, Types, and Modules.

Exports CommitInfo interface with hash/shortHash/author/date/message fields. Main async function logChange() accepts changed file paths and optional commit hash, reads commit metadata via git log, creates/merges a Change node in Neo4j with properties (hash, shortHash, author, date, message, fileCount, recordedAt=timestamp()), then executes three separate MATCH-MERGE queries to link CHANGED_IN edges from all Function, Type, and Module nodes in those file paths to the Change node. Helper readCommitInfo() parses git log output using format string '%H|%h|%an|%aI|%s' and splits on pipe delimiter. getRecentChanges(limit=10) queries Change nodes ordered descending by recordedAt and maps records to CommitInfo array. Uses process.cwd() for REPO_ROOT and Neo4j write transactions with rollback on error.

- **Exports:** `CommitInfo`, `logChange`, `getRecentChanges`
- **Key constants:** `REPO_ROOT=process.cwd()`, `default limit=10 for getRecentChanges`, `git log format=%H\|%h\|%an\|%aI\|%s`
- **Deps:** `child_process.execSync`, `../mcp-server/neo4j-client.js (getDriver, runQuery)`
- **Gotchas:** Uses MERGE strategy which upserts Change nodes (re-recording same commit idempotent); git log format is fixed pipe-delimited string; error handling logs warnings and returns/throws without retrying; file paths normalized from backslash to forward slash for graph consistency.

#### domain-classifier.ts
*module* — Domain classification system for PKG Function nodes; provides canonical domain labels and persistence layer.

Exports DOMAIN_LABELS as a const array of 13 domain categories (decision-making, communication, learning, drive-engine, planning, knowledge-graph, event-backbone, database, web-api, metrics, orchestration, shared-utilities, testing, unclassified) mapped to subsystem ownership. DomainLabel is a discriminated string union type. isSignificantChange() checks if changed fields (full, jsDoc, returnType, bodyText, args) warrant re-classification. writeDomainLabels() batch-persists ClassificationResult[] (name, filePath, domain) to Neo4j Function nodes via a single write transaction with rollback on failure. Classification itself is explicitly done externally (via local skill), not in this pipeline.

- **Exports:** `DOMAIN_LABELS`, `DomainLabel`, `ClassificationResult`, `isSignificantChange`, `writeDomainLabels`
- **Key constants:** `DOMAIN_LABELS (13 entries)`, `SIGNIFICANT_CHANGE_FIELDS={'full','jsDoc','returnType','bodyText','args'}`
- **Deps:** `neo4j-driver`
- **Gotchas:** Empty results in writeDomainLabels early-return is safe; external classification required (no inline classifier present); relies on Function nodes pre-existing in Neo4j by filePath+name; no validation of domain enum membership before write.

#### git-diff.ts
*util* — Detect and track TypeScript file changes in monorepo since last sync commit

Exports getChangedFiles() which reads a .last-sync-commit marker to compute git diff, filtering to watched directories (apps/sylphie/src, packages/shared/src, packages/decision-making/src, packages/drive-engine/src, frontend/src) and excluding node_modules, dist, test files, and .d.ts. On first run (no marker) returns all watched files; on subsequent runs runs git diff --name-only lastCommit..HEAD. Exports writeLastSyncCommit() to advance the cursor, readLastSyncCommit() to retrieve it, and getDeletedFiles() to report removals. Uses execSync for git commands, fs.readdirSync for recursive directory walk. Internal isWatchedFile() validates file meets directory and extension criteria.

- **Exports:** `DiffResult`, `getChangedFiles`, `writeLastSyncCommit`, `readLastSyncCommit`, `getDeletedFiles`
- **Key constants:** `REPO_ROOT=process.cwd()`, `LAST_SYNC_FILE=path.join(REPO_ROOT, 'packages', 'sylphie-pkg', '.last-sync-commit')`, `WATCHED_DIRECTORIES=[apps/sylphie/src, packages/shared/src, packages/decision-making/src, packages/drive-engine/src, frontend/src]`
- **Gotchas:** Assumes .last-sync-commit file lives at packages/sylphie-pkg/.last-sync-commit (hardcoded relative path); catches git cat-file errors if commit is unreachable and falls back to full scan; no locking around concurrent writes to .last-sync-commit; path normalization converts backslash to forward slash but REPO_ROOT may contain backslashes on Windows

#### graph-differ.ts
*service* — Diffs fresh AST output against Neo4j graph state to produce node/edge changesets for PKG sync.

Exports computeChangeset() which compares ParsedFiles (from ast-parser) against current graph Functions, Types, and IMPORTS edges via Neo4j queries. Detects creates (new nodes), updates (contentHash mismatch), deletes (removed code), and edge changes. Uses SHA-256 contentHash comparison; tracks changes at file granularity with per-file function/type/import diffs. Handles deleted files separately. Returns Changeset with nodesToCreate/Update/Delete and edgesToAdd/Remove lists; all changes are Neo4j node/edge mutations. Helper functions fetchGraphFunctions/Types/Imports() batch-query current state keyed by filePath::name or filePath::moduleSpecifier.

- **Exports:** `computeChangeset`, `NodeCreate`, `NodeUpdate`, `NodeDelete`, `EdgeAdd`, `EdgeRemove`, `Changeset`
- **Key constants:** `GraphNode keyed map format: filePath::name`, `GraphImportEdge keyed map format: filePath::moduleSpecifier`
- **Deps:** `../mcp-server/neo4j-client.js (runQuery)`, `./ast-parser.js (ParsedFile, ParsedFunction, ParsedType, ParsedImport)`
- **Gotchas:** changedFields hardcoded to ["full"] on hash mismatch—no field-level delta. Imports compared only by moduleSpecifier key, ignoring importedNames diffs. No cascade delete logic—callers handle referential integrity. Neo4j queries assume f.filePath, f.contentHash exist; null contentHash accepted but may cause false-positives on first sync.

#### integrity-checker.ts
*service* — Post-mutation validation harness for PKG graph integrity; catches structural defects introduced by sync operations.

Exports IntegrityIssue and IntegrityResult types; runs six async checks via runIntegrityChecks(): checkDuplicateFunctions (finds Function nodes with identical filePath+name), checkFunctionRequiredProps (ensures name/filePath/lineNumber exist), checkOrphanedImports (detects IMPORTS edges with missing Module source), checkOrphanedContainsEdges (flags CONTAINS edges targeting non-Function/Type nodes), checkBelongsToChain (verifies all Functions have BELONGS_TO path to Service, 1-3 hops), checkDuplicateTypes (finds Type nodes with identical filePath+name). Results aggregated via Promise.allSettled(); errors are converted to warnings. Logs summary with error count and examples (max 10 per issue, max 20 total per check). Exit code 0 if no errors, 1 if any error found. Invokable standalone via npm run validate-pkg via fileURLToPath gate.

- **Exports:** `IntegrityIssue`, `IntegrityResult`, `runIntegrityChecks`
- **Key constants:** `LIMIT=20 per check`, `BELONGS_TO chain depth=1..3 hops`
- **Deps:** `../mcp-server/neo4j-client.js via runQuery`
- **Gotchas:** checkOrphanedImports logic appears incomplete—query checks startNode Module exists but doesn't validate target; checkBelongsToChain warning severity despite being a structural requirement suggests residual acceptance tolerance; no explicit stub markers but design assumes seed repairs orphaned chains

#### mutation-builder.ts
*util* — Convert graph diff changesets into executable Cypher mutations for Neo4j atomic transactions

Transforms Changeset objects (from graph-differ) into parameterized CypherStatement arrays for safe Neo4j write operations. Core functions: buildFunctionCreate/Update (MERGE Function nodes with CONTAINS/DEFINES/HAS_CODE edges, caps bodyText at 8000 chars), buildTypeCreate/Update (MERGE Type nodes, builds EXTENDS/IMPLEMENTS/INJECTS edges for inheritance/injection, skips unknown or >80 char type names), buildCallsEdges (DELETE then re-MERGE CALLS edges with suffix matching), buildUsesTypeEdges (DELETE then MERGE USES_TYPE edges), buildFileCreate (MERGE File nodes under Module container), buildNodeDelete (DETACH DELETE Function/Type), buildDeletedFileNodes (cascading deletion of CodeBlock/Function/Type/File/Module by filePath), buildEdgeAdd/Remove (IMPORTS edge lifecycle). applyMutations() executes statements in a single Neo4j WRITE transaction with automatic rollback on error.

- **Exports:** `CypherStatement`, `buildFileCreate`, `buildMutations`, `applyMutations`
- **Key constants:** `bodyText slice limit = 8000`, `type name length skip threshold = 80`
- **Deps:** `path`, `./graph-differ.js`, `./ast-parser.js`
- **Gotchas:** buildEdgeAdd returns dummy RETURN 1 for non-IMPORTS edges (incomplete edge handler); buildCallsEdges and buildUsesTypeEdges issue DELETE-then-MERGE which is safe but inefficient for many references; EXTENDS/IMPLEMENTS match on Type {name: ...} without filePath, so same-named types in different files could collide (potential cross-file type reference bug); constructorParams loop skips targets where length > 80, silently dropping complex injection signatures

#### sync-pipeline.ts
*service* — Orchestrator for PKG graph sync: detects code changes, parses AST, computes graph diff, applies Neo4j mutations, logs changes, validates integrity.

Main entry point `runSync()` executes an 8-step pipeline: (1) git-diff identifies changed/deleted files since .last-sync-commit; (2) ts-morph parser extracts functions/types/imports from changed files; (3) graph-differ computes changeset (nodes/edges to create/update/delete); (4) mutation-builder converts changeset to Cypher statements; (5) applyMutations executes statements against Neo4j driver; (6) logChange records a Change node linking commit to affected files; (7) runIntegrityChecks validates graph coherence, fails on error; (8) writeLastSyncCommit advances cursor. Helper formatDuration() formats ms to s/ms. printStep/printSummary format console output. Bails early if no changes (step 1). Fatal failures on mutation errors (step 5, exit 1) and integrity failure (step 7, exit 1). Warning (non-fatal) on change-logging failure (step 6). Returns void; called via `npm run sync-pkg` or imported as named export.

- **Exports:** `runSync`
- **Key constants:** `TOTAL_STEPS=8`
- **Deps:** `./git-diff.js`, `./ast-parser.js`, `./graph-differ.js`, `./mutation-builder.js`, `./change-logger.js`, `./integrity-checker.js`, `../mcp-server/neo4j-client.js`
- **Gotchas:** No input validation on diffResult or changeset structures; assumes git-diff, parser, differ, mutation-builder, change-logger, integrity-checker all succeed or throw. Driver closure is defensive (called in catch blocks and finally paths) but closeDriver() may be called twice if mutation AND integrity fail (not fatal but worth noting). Early return on empty changeset (step 1) doesn't record a Change node — intent unclear. formatDuration hardcoded to 1 s threshold and toFixed(1).

## Risks / stubs / TODOs

- `packages/sylphie-pkg/src/ingestion/backfill-changes.ts` — No error if getChangedFiles fails on a commit — warns and skips edges for that commit. Neo4j constraint created IF NOT EXISTS on each run (safe but redundant). Path normalization strips backslashes for both local filePath matching and parameter passing, may mask platform-specific bugs. No validation that Function/Type nodes exist before wiring edges.
- `packages/sylphie-pkg/src/ingestion/initial-seed.ts` — CALLS/USES_TYPE/EXTENDS/IMPLEMENTS edge creation uses silent catch blocks (skip unresolvable) — failed edges are not reported; constructor param injection filter skips unknown types or names > 80 chars; batch transaction rollback only logs stderr warning, does not fail the seed; no explicit check for duplicate nodes before MERGE (relies on Neo4j MERGE semantics).
- `packages/sylphie-pkg/src/ingestion/manual-constraints.ts` — Function-scoped constraints require filePath::functionName format (no validation if missing ::). Module scope with relative paths auto-resolves to absolute; service scope normalizes \\ to /. MERGE Constraint always succeeds even if target node match fails (linked=0) — warning logged but no error thrown, could mask missing seed data. Tags defaulted to ['general'] if empty array. Neo4j integer conversion via .toNumber() for compatibility.
- `packages/sylphie-pkg/src/mcp-server/index.ts` — Error handler mentions bolt://localhost:7691 hardcoded in error message; relies on external Neo4j service running; all tool handlers are async and can fail; no validation that handlers actually exist before dispatch (relies on import side-effects).
- `packages/sylphie-pkg/src/mcp-server/tools/getConstraints.ts` — No validation of scope input; relies on regex matching which could be slow on large graphs. Suggests checking docs/CANON.md when no constraints found (manual fallback, not automatic). Deduplication by description string may miss semantically identical constraints with slightly different wording.
- `packages/sylphie-pkg/src/mcp-server/tools/getDataFlow.ts` — Depth clamped to 6 to avoid expensive graph traversals; uses LIMIT 50 on results to cap output; multiple start-node matches return warning but proceed with first match; relies on Neo4j PKG having Function/Type nodes with CALLS\|USES_TYPE\|IMPORTS\|CONTAINS\|INJECTS\|EXTENDS\|IMPLEMENTS edges populated correctly
- `packages/sylphie-pkg/src/mcp-server/tools/getFunctionDetail.ts` — Body text may not be stored in PKG (falls back to message "body not stored"). Multi-match disambiguation requires filePath re-query. Class methods stored as "ClassName.methodName" (not obvious from error message alone). Date slicing assumes ISO format (date.slice(0,10)).
- `packages/sylphie-pkg/src/mcp-server/tools/getLogContext.ts` — Assumes NestJS winston format with ISO date prefix; log format parsing via regex may fail silently if logs differ; no validation of 'since' input format—bare date comparison assumes YYYY-MM-DD; early file date skip may miss logs if filename doesn't match pattern; readline crlfDelay:Infinity handles CRLF but untested on Windows (likely works)
- `packages/sylphie-pkg/src/mcp-server/tools/getModuleContext.ts` — LIMIT 60 on functions, LIMIT 40 on types, LIMIT 20 on constraints — may truncate large modules; no pagination mechanism; regex pattern is case-insensitive (?i) and matches anywhere in field (.*pattern.*)
- `packages/sylphie-pkg/src/mcp-server/tools/getRecentChanges.ts` — No explicit null checks on runQuery results; assumes neo4j client returns valid records. Truncation of functions at 10 and types at 5 is hardcoded (lines 127, 136); regex search is case-insensitive (?i). Date filtering allows NULL since (line 30), treating it as unlimited lookback. No pagination for large result sets beyond limits.
- `packages/sylphie-pkg/src/mcp-server/tools/searchContent.ts` — Fallback query only runs if primary CodeBlock query returns zero results; bodyText on Function nodes is legacy pattern; no handling of multiline bodyText edge cases beyond naive split('\n')
- `packages/sylphie-pkg/src/sync/ast-parser.ts` — No error recovery for malformed AST; extractCallees filters calls >80 chars (may hide long-form callees); decorator extraction silently catches errors (skips); parseFiles writes to stderr on error but does not throw, returns partial results; ts-morph Project caching assumes tsconfig stability across calls
- `packages/sylphie-pkg/src/sync/change-logger.ts` — Uses MERGE strategy which upserts Change nodes (re-recording same commit idempotent); git log format is fixed pipe-delimited string; error handling logs warnings and returns/throws without retrying; file paths normalized from backslash to forward slash for graph consistency.
- `packages/sylphie-pkg/src/sync/domain-classifier.ts` — Empty results in writeDomainLabels early-return is safe; external classification required (no inline classifier present); relies on Function nodes pre-existing in Neo4j by filePath+name; no validation of domain enum membership before write.
- `packages/sylphie-pkg/src/sync/git-diff.ts` — Assumes .last-sync-commit file lives at packages/sylphie-pkg/.last-sync-commit (hardcoded relative path); catches git cat-file errors if commit is unreachable and falls back to full scan; no locking around concurrent writes to .last-sync-commit; path normalization converts backslash to forward slash but REPO_ROOT may contain backslashes on Windows
- `packages/sylphie-pkg/src/sync/graph-differ.ts` — changedFields hardcoded to ["full"] on hash mismatch—no field-level delta. Imports compared only by moduleSpecifier key, ignoring importedNames diffs. No cascade delete logic—callers handle referential integrity. Neo4j queries assume f.filePath, f.contentHash exist; null contentHash accepted but may cause false-positives on first sync.
- `packages/sylphie-pkg/src/sync/integrity-checker.ts` — checkOrphanedImports logic appears incomplete—query checks startNode Module exists but doesn't validate target; checkBelongsToChain warning severity despite being a structural requirement suggests residual acceptance tolerance; no explicit stub markers but design assumes seed repairs orphaned chains
- `packages/sylphie-pkg/src/sync/mutation-builder.ts` — buildEdgeAdd returns dummy RETURN 1 for non-IMPORTS edges (incomplete edge handler); buildCallsEdges and buildUsesTypeEdges issue DELETE-then-MERGE which is safe but inefficient for many references; EXTENDS/IMPLEMENTS match on Type {name: ...} without filePath, so same-named types in different files could collide (potential cross-file type reference bug); constructorParams loop skips targets where length > 80, silently dropping complex injection signatures
- `packages/sylphie-pkg/src/sync/sync-pipeline.ts` — No input validation on diffResult or changeset structures; assumes git-diff, parser, differ, mutation-builder, change-logger, integrity-checker all succeed or throw. Driver closure is defensive (called in catch blocks and finally paths) but closeDriver() may be called twice if mutation AND integrity fail (not fatal but worth noting). Early return on empty changeset (step 1) doesn't record a Change node — intent unclear. formatDuration hardcoded to 1 s threshold and toFixed(1).

## Change log
- 2026-06-13 — Initial auto-generated map (20 files read in full).
