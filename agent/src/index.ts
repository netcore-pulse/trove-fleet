/**
 * Public surface of the Trove Subscriber Agent spine (A0).
 *
 * A0 = durable store + state machine + seed ingest + persona pool + the two
 * archive clients + a confirm-link whitelist seam. It does NOT drive browsers
 * (that is A1/A2) and never follows arbitrary links.
 */

export { loadConfig, type AgentConfig } from "./config.ts";
export {
  STATUSES,
  type Status,
  isStatus,
  canTransition,
  assertTransition,
  isTerminal,
  isConfirmedOrInFlight,
  IllegalTransitionError,
} from "./state.ts";
export {
  canonicalizeDomain,
  parseSeedText,
  brandSlugFromDomain,
  type SeedRow,
} from "./canonical.ts";
export { personaForDomain, type Persona, PERSONA_SPACE } from "./persona.ts";
export { TargetStore, type TargetRow, type IngestResult } from "./store.ts";
export {
  ArchiveClient,
  ArchiveError,
  type AddressResponse,
  type ConfirmationResponse,
  type BrandInput,
  type FetchLike,
} from "./archive-client.ts";
export {
  isConfirmLink,
  extractConfirmLinks,
  CONFIRM_URL_PATTERNS,
  REFUSE_URL_PATTERNS,
  CONFIRM_INTENT_TEXT_PATTERNS,
  REFUSE_INTENT_TEXT_PATTERNS,
} from "./confirm-link.ts";

// ── A1: the single-target subscribe loop (Playwright) ───────────────────────────
export {
  fingerprintForPersona,
  type Fingerprint,
} from "./browser/fingerprint.ts";
export {
  dismissOverlays,
  looksLikeDismissControl,
  type DismissResult,
} from "./browser/overlays.ts";
export { BrowserWorker, type BrowserWorkerOptions, type OpenPageResult } from "./browser/worker.ts";
export {
  rankCandidates,
  extractCandidates,
  detectEsp,
  ESP_SIGNATURES,
  type FieldCandidate,
  type FormPick,
  type Esp,
} from "./form-finder.ts";
export { classifyOutcome, type Outcome, type PageSnapshot } from "./outcome.ts";
export {
  subscribeOnPage,
  runSubscribe,
  personaValueForField,
  type MintFn,
  type SubscribeOnPageOptions,
  type SubscribeOutcome,
  type RunSubscribeOptions,
  type RunSubscribeResult,
} from "./subscribe.ts";

// ── A2: the confirm loop ─────────────────────────────────────────────────────
export {
  runConfirmLoop,
  processConfirmation,
  httpGetClick,
  playwrightClick,
  type ClickFn,
  type ClickResult,
  type ConfirmDisposition,
  type ConfirmItemResult,
  type RunConfirmLoopOptions,
  type RunConfirmLoopResult,
} from "./confirm-loop.ts";

// ── A3: fleet + footprint ────────────────────────────────────────────────────
export {
  type Clock,
  systemClock,
  ManualClock,
} from "./fleet/clock.ts";
export {
  type ProxyPool,
  type ProxyLease,
  type ProxyHealth,
  EnvProxyPool,
  NullProxyPool,
  proxyPoolFromEnv,
  type ProxyPoolOptions,
} from "./fleet/proxy-pool.ts";
export {
  Throttle,
  type ThrottleOptions,
  DEFAULT_THROTTLE,
  throttleOptionsFromEnv,
} from "./fleet/throttle.ts";
export {
  runFleet,
  type AttemptStep,
  type AttemptContext,
  type AttemptResult,
  type AttemptStatus,
  type FleetPoolOptions,
  type FleetRunResult,
} from "./fleet/pool.ts";
export { makeSubscribeStep, type SubscribeStepOptions } from "./fleet/subscribe-step.ts";

// ── A4: observability ────────────────────────────────────────────────────────
export {
  computeMetrics,
  formatMetrics,
  percentile,
  type FleetMetrics,
  type LatencyStats,
  type EspStat,
} from "./observability/metrics.ts";
export {
  evaluateAlerts,
  formatAlerts,
  DEFAULT_ALERT_THRESHOLDS,
  type Alert,
  type AlertLevel,
  type AlertCode,
  type AlertThresholds,
} from "./observability/alerts.ts";

// ── A5: run modes ────────────────────────────────────────────────────────────
export { runBurst, type BurstOptions, type BurstResult } from "./run/burst.ts";
export {
  runMaintenance,
  type MaintenanceOptions,
  type MaintenanceResult,
} from "./run/maintenance.ts";
