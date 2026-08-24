/**
 * The structured input to the hourly report.
 *
 * WHY THIS TYPE EXISTS AT ALL
 * Section 5 says the report should read "like a sharp analyst's briefing, not a metrics
 * dump", composed by an LLM. That is right, and it is also a dependency on a network
 * call that can fail, rate-limit, or hallucinate a number.
 *
 * So the pipeline is: gather these facts from ClickHouse and Postgres -> render them
 * deterministically (compose.ts) -> optionally hand the same facts to Claude for the
 * prose passes. The deterministic render is the contract and the fallback; the model
 * makes it read better, never makes up what it says. A number that appears in the
 * report always came from this object.
 */

export interface ServiceHealth {
  readonly name: string;
  readonly status: 'up' | 'degraded' | 'down';
  readonly detail?: string;
}

export interface TrafficRow {
  readonly label: string;
  readonly value: number;
  /** Change against the same hour last week, as a fraction. Not against last hour. */
  readonly deltaVsLastWeek: number;
}

export interface TrafficSection {
  readonly sessions: number;
  readonly uniques: number;
  readonly pageviews: number;
  readonly newVisitors: number;
  readonly returningVisitors: number;
  readonly sessionsDeltaVsLastWeek: number;
  readonly topSources: readonly TrafficRow[];
  readonly topCountries: readonly TrafficRow[];
  readonly topPages: readonly TrafficRow[];
}

export interface ProviderSignups {
  readonly provider: string;
  readonly signups: number;
  readonly conversionRate: number;
}

export interface FunnelStep {
  readonly step: string;
  readonly sessions: number;
  /** Fraction of the previous step that reached this one. */
  readonly stepConversion: number;
  /** Change in `stepConversion` against the same hour last week. */
  readonly deltaVsLastWeek: number;
}

export interface ConversionSection {
  readonly signups: number;
  readonly signupRate: number;
  readonly activationRate: number;
  readonly byProvider: readonly ProviderSignups[];
  readonly funnel: readonly FunnelStep[];
}

export type AdaptationAction =
  'generated' | 'promoted' | 'retired' | 'quarantined' | 'released' | 'pinned' | 'rolled_back';

export interface AdaptationEntry {
  readonly action: AdaptationAction;
  readonly surfaceId: string;
  readonly variantId: string;
  readonly variantLabel: string;
  /** Plain English, from `adaptation_log.reason`. */
  readonly reason: string;
  readonly impressions?: number;
}

export interface SurfaceChampion {
  readonly surfaceId: string;
  readonly variantId: string;
  readonly variantLabel: string;
  readonly posteriorMean: number;
  readonly credibleInterval: readonly [number, number];
  readonly impressions: number;
  readonly activeVariants: number;
}

export interface AdaptationSection {
  readonly entries: readonly AdaptationEntry[];
  readonly champions: readonly SurfaceChampion[];
  /** What the live theme looks like right now, in words. */
  readonly liveTheme: {
    readonly palette: string;
    readonly typography: string;
    readonly density: string;
    readonly motion: string;
  };
}

export interface TrendCluster {
  readonly id: string;
  readonly label: string;
  readonly momentum: number;
  readonly audienceFit: number;
  readonly saturation: number;
  readonly documentCount: number;
}

export interface SafetyRejection {
  readonly label: string;
  readonly reason: string;
}

export interface WebIntelligenceSection {
  readonly newClusters: readonly TrendCluster[];
  readonly published: readonly { readonly title: string; readonly slug: string }[];
  readonly queued: readonly { readonly title: string }[];
  readonly rejected: readonly SafetyRejection[];
  readonly documentsFetched: number;
  readonly hostsCrawled: number;
}

export interface PlatformActivity {
  readonly platform: string;
  readonly posted: number;
  readonly impressions: number;
  readonly engagements: number;
  readonly followerDelta: number;
  /** Fraction of the self-imposed daily cap still available. */
  readonly rateLimitHeadroom: number;
}

export interface SocialSection {
  readonly platforms: readonly PlatformActivity[];
  readonly awaitingApproval: number;
  readonly autonomy: 'manual' | 'review' | 'auto';
}

export interface HoldoutSection {
  readonly hourLiftRelative: number;
  readonly cumulativeLiftRelative: number;
  readonly cumulativePValue: number;
  readonly conclusive: boolean;
  readonly adaptiveRewardPerImpression: number;
  readonly holdoutRewardPerImpression: number;
  readonly holdoutFraction: number;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly detail: string;
}

export interface NextHourSection {
  readonly intentions: readonly string[];
  /** Decisions that genuinely need a human. Empty most hours, and that is correct. */
  readonly needsOperator: readonly string[];
}

export interface ReportInput {
  /** Start of the hour covered, ISO-8601 in the operator's timezone. */
  readonly hourStart: string;
  readonly timezone: string;
  readonly uptimeSeconds: number;
  readonly services: readonly ServiceHealth[];
  readonly traffic: TrafficSection;
  readonly conversion: ConversionSection;
  readonly adaptation: AdaptationSection;
  readonly web: WebIntelligenceSection;
  readonly social: SocialSection;
  readonly holdout: HoldoutSection;
  readonly alerts: readonly Alert[];
  readonly next: NextHourSection;
  /** Reward weight version in force, so incomparable epochs are never compared. */
  readonly rewardVersion: number;
}
