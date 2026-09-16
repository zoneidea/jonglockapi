/* Offline metadata only. Never imports app config, dotenv, or a database driver. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const migrations = fs.readdirSync(path.join(root, 'migrations'))
  .filter((name) => name.endsWith('.sql')).sort().map((filename) => {
    const sql = fs.readFileSync(path.join(root, 'migrations', filename), 'utf8');
    return {
      filename,
      sha256: crypto.createHash('sha256').update(sql).digest('hex'),
      declaredTables: [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)/gi)].map((m) => m[1]),
    };
  });
const patterns = {
  upsert: /ON DUPLICATE KEY|INSERT IGNORE/i,
  dates: /DATE_FORMAT|DATE_ADD|DATE_SUB|DATEDIFF|TIMESTAMPDIFF|CURDATE\(/i,
  json: /JSON_EXTRACT|JSON_UNQUOTE|JSON_CONTAINS/i,
  aggregation: /GROUP_CONCAT|FIND_IN_SET/i,
  mysqlResult: /insertId|affectedRows/,
  locking: /FOR UPDATE|GET_LOCK|RELEASE_LOCK/i,
  nullAndConditional: /IFNULL\(|\bIF\(/i,
};
const candidates = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(absolute);
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      fs.readFileSync(absolute, 'utf8').split('\n').forEach((line, index) => {
        const categories = Object.entries(patterns).filter(([, regex]) => regex.test(line)).map(([name]) => name);
        // Output locations/categories only, never source text or credentials.
        if (categories.length) candidates.push({ file: path.relative(root, absolute), line: index + 1, categories });
      });
    }
  }
}
scan(path.join(root, 'src'));
console.log(JSON.stringify({
  kind: 'offline-preparation-only',
  warning: 'Static declarations and candidate locations are not live schema or an exhaustive SQL audit.',
  migrations,
  declaredTables: [...new Set(migrations.flatMap((m) => m.declaredTables))].sort(),
  runtimeCreatedTables: ['schema_migrations'],
  mysqlCompatibilityCandidates: candidates,
}, null, 2));
