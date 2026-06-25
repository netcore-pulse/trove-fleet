/**
 * Runtime configuration, sourced from the environment with safe dev defaults.
 *
 * The two archive seams (base URL + bearer token) and the durable store path
 * are all overridable so the same binary runs in dev, CI, and prod.
 */

export interface AgentConfig {
  /** Base URL of the Trove Rails archive internal API. */
  archiveUrl: string;
  /** Bearer token for the internal API. */
  internalApiToken: string;
  /** Filesystem path to the SQLite target store. */
  dbPath: string;
  /** Stable worker id used for leasing + confirmation claims. */
  workerId: string;
}

const DEFAULTS = {
  archiveUrl: "http://localhost:3033",
  dbPath: "./data/targets.db",
  workerId: "agent-1",
} as const;

// Convenience dev token — used ONLY outside production (forward-pass M8). In
// production TROVE_INTERNAL_API_TOKEN is required; without it the token resolves
// to "" so requests fail against the archive rather than shipping a published
// default secret.
const DEV_INTERNAL_API_TOKEN = "dev-only-internal-token";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const isProd = env.NODE_ENV === "production";
  return {
    archiveUrl: env.TROVE_ARCHIVE_URL?.trim() || DEFAULTS.archiveUrl,
    internalApiToken:
      env.TROVE_INTERNAL_API_TOKEN?.trim() || (isProd ? "" : DEV_INTERNAL_API_TOKEN),
    dbPath: env.TROVE_AGENT_DB?.trim() || DEFAULTS.dbPath,
    workerId: env.TROVE_WORKER_ID?.trim() || DEFAULTS.workerId,
  };
}
