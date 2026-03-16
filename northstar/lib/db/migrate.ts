import { getPool, closePool } from "./client";

const migrations = [
  {
    name: "001_create_oauth_credentials",
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_credentials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL DEFAULT 'default',
        provider VARCHAR(50) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TIMESTAMP WITH TIME ZONE,
        scopes TEXT[],
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(user_id, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_credentials_user_provider
        ON oauth_credentials(user_id, provider);
    `,
  },
  {
    name: "002_create_scheduled_checkins",
    sql: `
      CREATE TABLE IF NOT EXISTS scheduled_checkins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL DEFAULT 'default',
        scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        triggered_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_checkins_status_scheduled
        ON scheduled_checkins(status, scheduled_at);

      CREATE INDEX IF NOT EXISTS idx_scheduled_checkins_user
        ON scheduled_checkins(user_id);
    `,
  },
  {
    name: "003_create_migrations_table",
    sql: `
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `,
  },
];

async function runMigrations() {
  const pool = getPool();

  // Ensure migrations table exists first
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  // Get already applied migrations
  const result = await pool.query("SELECT name FROM migrations");
  const appliedMigrations = new Set(result.rows.map((r) => r.name));

  // Run pending migrations
  for (const migration of migrations) {
    if (appliedMigrations.has(migration.name)) {
      console.log(`[Migration] Skipping ${migration.name} (already applied)`);
      continue;
    }

    console.log(`[Migration] Running ${migration.name}...`);
    try {
      await pool.query(migration.sql);
      await pool.query("INSERT INTO migrations (name) VALUES ($1)", [
        migration.name,
      ]);
      console.log(`[Migration] Completed ${migration.name}`);
    } catch (error) {
      console.error(`[Migration] Failed ${migration.name}:`, error);
      throw error;
    }
  }

  console.log("[Migration] All migrations complete");
}

// Run if executed directly
if (require.main === module) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { runMigrations };
