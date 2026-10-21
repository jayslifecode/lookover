export type { EnsureAuthOptions, EnsureAuthResult } from './browser/auth.js';
export { checkStorageState, ensureAuth, isLoginUrl } from './browser/auth.js';
export type { AXNode } from './browser/cdp.js';
export { boxFor, callOnNode, getAXTree, resolveBackendNode } from './browser/cdp.js';
export type { NetworkPolicy, RequestKind, ResolverTestHooks, Verdict } from './browser/network-policy.js';
export {
  BLOCKED_PROVIDERS,
  classifyRequest,
  hostResolverRules,
  isAllowedHost,
  isBlockedProvider,
  LOCAL_HOSTS,
  normaliseHost,
} from './browser/network-policy.js';
export type { InstrumentedPage, SessionEvent, SessionOptions } from './browser/session.js';
export { BrowserSession } from './browser/session.js';
export { assertAcknowledged, CONFIG_FILENAME, detectIndent, loadConfig, writeConfig } from './config/load.js';
export type { LookoverConfig } from './config/schema.js';
export { configSchema } from './config/schema.js';
export type { ErrorCode } from './errors.js';
export { LookoverError } from './errors.js';
export type { EvidenceRef } from './evidence/store.js';
export { EvidenceStore } from './evidence/store.js';
export type { OccurrenceFindingInput } from './findings/build.js';
export { occurrenceFinding } from './findings/build.js';
export type { FixPromptInput } from './findings/fix-prompt.js';
export { fixPromptFor } from './findings/fix-prompt.js';
export { findingId, mergeFindings } from './findings/id.js';
export type { Lens, LensContext, LensResult, LensSkip } from './findings/lens.js';
export { FINDINGS_FILE, readLatestFindings, writeFindings } from './findings/persist.js';
export type {
  ElementTarget,
  EvidenceItem,
  Finding,
  FindingSource,
  FindingStatus,
  FindingsFile,
  ForcedState,
  LensName,
  Occurrence,
  OccurrenceFinding,
  RuleRef,
  Severity,
  Step,
  StepFinding,
  StepTrace,
} from './findings/types.js';
export type { CrawlOptions } from './map/crawler.js';
export { crawl } from './map/crawler.js';
export { extractElements, INTERACTIVE_ROLES, MAX_ELEMENTS_PER_SCREEN } from './map/elements.js';
export { extractForms } from './map/forms.js';
export { DESTRUCTIVE_LINK_PATTERN, isDestructiveLink } from './map/links.js';
export {
  discoverNextRoutes,
  matchRoute,
  routePatternFromPath,
  staticRoutePatterns,
} from './map/next-routes.js';
export type { AppMapDiff } from './map/persist.js';
export { APP_MAP_FILE, diffAppMaps, readLatestAppMap, writeAppMap } from './map/persist.js';
export type { SelectorCandidate } from './map/selectors.js';
export { BUILD_SELECTOR_SOURCE, stableSelector } from './map/selectors.js';
export { collectTokens } from './map/tokens.js';
export type {
  AppMap,
  Box,
  ElementRef,
  FieldInfo,
  FormInfo,
  RouteInfo,
  Screen,
  ScreenStatus,
  TokenProperty,
  TokenSample,
  Viewport,
} from './map/types.js';
export { isFailedScreen } from './map/types.js';
export { ConsoleObserver } from './observers/console.js';
export type { Observer, ObserverResult } from './observers/types.js';
export type { ConfirmHosts } from './run/backend-probe.js';
export { confirmHostCommand } from './run/backend-probe.js';
export type { ReviewHooks, ReviewOptions, ReviewResult } from './run/engine.js';
export { runReview } from './run/engine.js';
export type { RunEvent, RunEventBody } from './run/events.js';
export type { InspectionOptions } from './run/inspection.js';
export { Inspection, PER_SCREEN_BUDGET_MS } from './run/inspection.js';
export type { CreateRunOptions, RunContext } from './run/run-context.js';
export { createRun } from './run/run-context.js';
export type { RunLogOptions } from './run/run-log.js';
export { RunLog } from './run/run-log.js';
export type { WriteFileAtomicOptions } from './util/fs.js';
export { isMissingFile, writeFileAtomic } from './util/fs.js';
export { sha256, shortId } from './util/hash.js';
export { redact, redactDeep } from './util/redact.js';
export { isSameApp, normaliseUrl, resolveSeed, routeKey } from './util/url.js';
