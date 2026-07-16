const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const file = process.argv[2];
  if (!file || !process.env.SUPABASE_DB_URL) {
    throw new Error('Usage: SUPABASE_DB_URL=... node scripts/apply-sql.cjs <file.sql>');
  }
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL.replace(/[?&]sslmode=[^&]+/, ''),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query(fs.readFileSync(file, 'utf8'));
  await client.end();
  console.log(`Applied ${file}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
