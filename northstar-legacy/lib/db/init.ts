import { readFileSync } from "fs";
import { join } from "path";
import { getPool, closePool } from "./client";

export async function initializeDatabase(): Promise<void> {
  const pool = getPool();

  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  console.log("[DB] Initializing database schema...");

  try {
    await pool.query(schema);
    console.log("[DB] Schema initialized successfully");
  } catch (error) {
    console.error("[DB] Error initializing schema:", error);
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  initializeDatabase()
    .then(() => {
      console.log("[DB] Done");
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
