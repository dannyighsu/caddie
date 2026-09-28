import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import { CaseBase, SuiteConfig, type Driver, type LoadedCase } from "./types.ts";
import { inboundMessage } from "../drivers/inbound-message.ts";

export const EVALS_ROOT = resolve(import.meta.dirname, "..");
export const SUITES_DIR = resolve(EVALS_ROOT, "suites");

/** Drivers by name. A new run shape (scheduled job, Slack, portal) registers here. */
export const DRIVERS: Record<string, Driver> = {
  [inboundMessage.name]: inboundMessage,
};

export async function listSuites(): Promise<string[]> {
  const entries = await readdir(SUITES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && existsSync(resolve(SUITES_DIR, e.name, "suite.yaml"))).map((e) => e.name);
}

export interface LoadedSuite {
  config: SuiteConfig;
  driver: Driver;
  cases: LoadedCase[];
}

/** Load and validate a suite. Every case is validated up front, so a typo fails before any run starts. */
export async function loadSuite(name: string): Promise<LoadedSuite> {
  const dir = resolve(SUITES_DIR, name);
  if (!existsSync(resolve(dir, "suite.yaml"))) {
    throw new Error(`No suite "${name}". Available: ${(await listSuites()).join(", ")}`);
  }
  const config = SuiteConfig.parse(parseYaml(await readFile(resolve(dir, "suite.yaml"), "utf-8")));
  const driver = DRIVERS[config.driver];
  if (!driver) throw new Error(`Suite "${name}" uses unknown driver "${config.driver}"`);

  const casesDir = resolve(dir, "cases");
  const files = existsSync(casesDir) ? (await readdir(casesDir)).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const cases: LoadedCase[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const file = resolve(casesDir, f);
    try {
      const parsed = CaseBase.safeParse(parseYaml(await readFile(file, "utf-8")));
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(case)"}: ${i.message}`).join("; "));
      }
      const base = parsed.data;
      if (seen.has(base.id)) throw new Error(`duplicate id "${base.id}"`);
      seen.add(base.id);
      const c = { ...base, file } as LoadedCase;
      driver.validate(c, config);
      cases.push(c);
    } catch (err) {
      errors.push(`${f}: ${(err as Error).message}`);
    }
  }
  if (errors.length) throw new Error(`Invalid cases in suite "${name}":\n  ${errors.join("\n  ")}`);
  return { config, driver, cases };
}
