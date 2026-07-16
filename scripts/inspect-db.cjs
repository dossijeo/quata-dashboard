const { Client } = require('pg');
const fs = require('fs');

async function main() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error('SUPABASE_DB_URL is required');
  }

  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL.replace(/[?&]sslmode=[^&]+/, ''),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const sql = process.argv[2] === '--file'
    ? fs.readFileSync(process.argv[3], 'utf8')
    : process.argv[2] || `
    select table_name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name
  `;
  const result = await client.query(sql);
  const rows = Array.isArray(result)
    ? result.flatMap((entry) => entry.rows || [])
    : result.rows || [];
  console.log(JSON.stringify(rows, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
