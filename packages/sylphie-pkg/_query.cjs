const neo4j = require('neo4j-driver');
const d = neo4j.driver('bolt://localhost:7689', neo4j.auth.basic('neo4j','codebase-pkg-local'));

async function run() {
  const s = d.session();
  try {
    const query = process.argv[2];
    const tool = process.argv[3] || 'moduleContext';
    const pattern = '(?i).*' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*';

    if (tool === 'moduleContext') {
      const r = await s.run(`
        MATCH (m:Module)
        WHERE m.name =~ $pattern OR m.domain =~ $pattern OR m.description =~ $pattern OR m.packageName =~ $pattern
        OPTIONAL MATCH (m)-[:BELONGS_TO]->(svc:Service)
        RETURN m.name AS moduleName, m.filePath AS filePath, m.description AS description, m.domain AS domain, m.packageName AS packageName, svc.name AS serviceName
        UNION
        MATCH (m:Module)-[:BELONGS_TO]->(svc:Service)
        WHERE svc.name =~ $pattern
        RETURN m.name AS moduleName, m.filePath AS filePath, m.description AS description, m.domain AS domain, m.packageName AS packageName, svc.name AS serviceName
        UNION
        MATCH (m:Module)-[:CONTAINS]->(f:Function)
        WHERE f.name =~ $pattern
        OPTIONAL MATCH (m)-[:BELONGS_TO]->(svc:Service)
        RETURN DISTINCT m.name AS moduleName, m.filePath AS filePath, m.description AS description, m.domain AS domain, m.packageName AS packageName, svc.name AS serviceName
      `, { pattern });

      console.log('=== getModuleContext: "' + query + '" ===');
      console.log('Modules found: ' + r.records.length);
      for (const rec of r.records) {
        console.log('  Module: ' + rec.get('moduleName'));
        console.log('    Service: ' + (rec.get('serviceName') || 'none'));
        console.log('    Domain: ' + (rec.get('domain') || 'none'));
        console.log('    Package: ' + (rec.get('packageName') || 'none'));
        console.log('    Description: ' + (rec.get('description') || 'none'));
        console.log('    Path: ' + (rec.get('filePath') || 'none'));
      }

      // Also get functions for these modules
      const modulePaths = r.records.map(rec => rec.get('filePath'));
      if (modulePaths.length > 0) {
        const fns = await s.run(`
          MATCH (m:Module)-[:CONTAINS]->(f:Function)
          WHERE m.filePath IN $modulePaths
          RETURN f.name AS name, m.name AS moduleName, f.isExported AS isExported
          ORDER BY m.name, f.name
          LIMIT 30
        `, { modulePaths });
        console.log('  Functions (' + fns.records.length + '):');
        for (const rec of fns.records) {
          console.log('    [' + rec.get('moduleName') + '] ' + (rec.get('isExported') ? 'export ' : '') + rec.get('name'));
        }

        // Types
        const types = await s.run(`
          MATCH (m:Module)-[:CONTAINS]->(t:Type)
          WHERE m.filePath IN $modulePaths
          RETURN t.name AS name, t.kind AS kind, m.name AS moduleName
          ORDER BY m.name, t.name
          LIMIT 30
        `, { modulePaths });
        console.log('  Types (' + types.records.length + '):');
        for (const rec of types.records) {
          console.log('    [' + rec.get('moduleName') + '] ' + rec.get('name') + ' (' + (rec.get('kind') || '?') + ')');
        }

        // Constraints
        const constraints = await s.run(`
          MATCH (m:Module)-[:CONSTRAINED_BY]->(c:Constraint)
          WHERE m.filePath IN $modulePaths
          RETURN c.description AS description, c.severity AS severity, m.name AS moduleName
          LIMIT 20
        `, { modulePaths });
        console.log('  Constraints (' + constraints.records.length + '):');
        for (const rec of constraints.records) {
          console.log('    [' + (rec.get('severity') || '?') + '] (' + rec.get('moduleName') + ') ' + rec.get('description'));
        }
      }

    } else if (tool === 'constraints') {
      const r1 = await s.run(`
        MATCH (n)-[:CONSTRAINED_BY]->(c:Constraint)
        WHERE (n:Service OR n:Module OR n:Function)
          AND (n.name =~ $pattern OR n.domain =~ $pattern)
        RETURN c.description AS description, c.severity AS severity, c.source AS source, c.area AS area, n.name AS ownerName, labels(n) AS ownerLabels
        ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, n.name
        LIMIT 30
      `, { pattern });
      const r2 = await s.run(`
        MATCH (c:Constraint)
        WHERE c.name =~ $pattern OR c.area =~ $pattern
        RETURN c.description AS description, c.severity AS severity, c.source AS source, c.area AS area, null AS ownerName, [] AS ownerLabels
        ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
        LIMIT 10
      `, { pattern });
      console.log('=== getConstraints: "' + query + '" ===');
      const all = [...r1.records, ...r2.records];
      console.log('Constraints found: ' + all.length);
      const seen = new Set();
      for (const rec of all) {
        const desc = rec.get('description');
        if (seen.has(desc)) continue;
        seen.add(desc);
        console.log('  [' + (rec.get('severity') || '?') + '] ' + desc);
        if (rec.get('ownerName')) console.log('    owner: ' + rec.get('ownerName'));
        if (rec.get('area')) console.log('    area: ' + rec.get('area'));
      }

    } else if (tool === 'recentChanges') {
      const r = await s.run(`
        MATCH (c:Change)
        WHERE c.message =~ $pattern OR c.shortHash =~ $pattern
        RETURN c.hash AS hash, c.shortHash AS shortHash, c.message AS description, c.date AS date, c.author AS author, c.fileCount AS fileCount, id(c) AS nodeId
        ORDER BY c.date DESC
        LIMIT 15
      `, { pattern });
      console.log('=== getRecentChanges: "' + query + '" ===');
      console.log('Changes found: ' + r.records.length);
      for (const rec of r.records) {
        const fc = rec.get('fileCount');
        console.log('  ' + (rec.get('shortHash') || '') + ' | ' + (rec.get('date') || '') + ' | ' + (rec.get('description') || '') + ' | files: ' + (fc && typeof fc.toInt === 'function' ? fc.toInt() : fc));
      }

    } else if (tool === 'dataFlow') {
      const startName = query;
      const startRecs = await s.run(`
        MATCH (n) WHERE (n:Function OR n:Type) AND n.name = $name
        RETURN labels(n) AS labels, n.name AS name, n.filePath AS filePath
        LIMIT 5
      `, { name: startName });
      console.log('=== getDataFlow: "' + startName + '" ===');
      console.log('Start nodes found: ' + startRecs.records.length);
      for (const rec of startRecs.records) {
        console.log('  ' + JSON.stringify(rec.get('labels')) + ' ' + rec.get('name') + ' @ ' + rec.get('filePath'));
      }

      // upstream
      try {
        const up = await s.run(`
          MATCH path = (n)<-[:IMPORTS|DATA_FLOWS_TO*1..3]-(start)
          WHERE (start:Function OR start:Type) AND start.name = $name AND (n:Function OR n:Type)
          RETURN n.name AS name, n.filePath AS filePath, labels(n) AS labels, length(path) AS hopDistance
          ORDER BY hopDistance, n.name
          LIMIT 30
        `, { name: startName });
        console.log('  Upstream (' + up.records.length + '):');
        for (const rec of up.records) {
          const hop = typeof rec.get('hopDistance').toInt === 'function' ? rec.get('hopDistance').toInt() : rec.get('hopDistance');
          console.log('    hop ' + hop + ': ' + rec.get('name') + ' @ ' + rec.get('filePath'));
        }
      } catch(e) { console.log('  Upstream query error: ' + e.message); }

      // downstream
      try {
        const down = await s.run(`
          MATCH path = (start)-[:IMPORTS|DATA_FLOWS_TO*1..3]->(n)
          WHERE (start:Function OR start:Type) AND start.name = $name AND (n:Function OR n:Type)
          RETURN n.name AS name, n.filePath AS filePath, labels(n) AS labels, length(path) AS hopDistance
          ORDER BY hopDistance, n.name
          LIMIT 30
        `, { name: startName });
        console.log('  Downstream (' + down.records.length + '):');
        for (const rec of down.records) {
          const hop = typeof rec.get('hopDistance').toInt === 'function' ? rec.get('hopDistance').toInt() : rec.get('hopDistance');
          console.log('    hop ' + hop + ': ' + rec.get('name') + ' @ ' + rec.get('filePath'));
        }
      } catch(e) { console.log('  Downstream query error: ' + e.message); }
    }

  } catch(e) {
    console.error('ERROR:', e.message);
  } finally {
    await s.close();
    await d.close();
  }
}
run();
