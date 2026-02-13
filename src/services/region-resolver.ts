import type { GatewayConfig } from '../types/gateway';

/**
 * Region distance matrix for routing decisions.
 * Values represent relative latency (lower is better).
 * Mirrors the Python scheduler's region affinity logic.
 */
const REGION_DISTANCES: Record<string, Record<string, number>> = {
  'us-west':  { 'us-west': 0, 'us-east': 40, 'eu-west': 80, 'eu-central': 90, 'ap-east': 100 },
  'us-east':  { 'us-west': 40, 'us-east': 0, 'eu-west': 60, 'eu-central': 70, 'ap-east': 120 },
  'eu-west':  { 'us-west': 80, 'us-east': 60, 'eu-west': 0, 'eu-central': 10, 'ap-east': 90 },
  'eu-central': { 'us-west': 90, 'us-east': 70, 'eu-west': 10, 'eu-central': 0, 'ap-east': 80 },
  'ap-east':  { 'us-west': 100, 'us-east': 120, 'eu-west': 90, 'eu-central': 80, 'ap-east': 0 },
};

const DEFAULT_DISTANCE = 999;

/**
 * Region Resolver service.
 * Resolves client region from IP/headers and computes distances
 * between regions for affinity-based routing.
 */
export class RegionResolver {
  private config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /**
   * Resolve the client's region from request headers.
   * Checks common CDN/proxy headers for region hints.
   */
  resolveClientRegion(headers: Record<string, string | string[] | undefined>): string | undefined {
    // Check common CDN region headers
    const cfRegion = headers['cf-ipcountry'] as string;
    if (cfRegion) return this.countryToRegion(cfRegion);

    const awsRegion = headers['x-amzn-region'] as string;
    if (awsRegion) return awsRegion;

    // Check explicit client region header
    const clientRegion = headers['x-client-region'] as string;
    if (clientRegion) return clientRegion;

    return undefined;
  }

  /**
   * Get the distance between two regions.
   * Returns a relative latency score (0 = same region, higher = farther).
   */
  getDistance(fromRegion: string, toRegion: string): number {
    return REGION_DISTANCES[fromRegion]?.[toRegion] ?? DEFAULT_DISTANCE;
  }

  /**
   * Sort a list of regions by distance from a source region (closest first).
   */
  sortByDistance(fromRegion: string, regions: string[]): string[] {
    return [...regions].sort((a, b) => {
      return this.getDistance(fromRegion, a) - this.getDistance(fromRegion, b);
    });
  }

  /**
   * Find the closest region from a list of candidates.
   */
  findClosestRegion(fromRegion: string, candidates: string[]): string | undefined {
    if (candidates.length === 0) return undefined;
    return this.sortByDistance(fromRegion, candidates)[0];
  }

  /**
   * Get all known regions.
   */
  getKnownRegions(): string[] {
    return Object.keys(REGION_DISTANCES);
  }

  /**
   * Map ISO country code to a region.
   * Simplified mapping for common countries.
   */
  private countryToRegion(countryCode: string): string {
    const mapping: Record<string, string> = {
      US: 'us-west',
      CA: 'us-west',
      MX: 'us-west',
      BR: 'us-east',
      GB: 'eu-west',
      FR: 'eu-west',
      DE: 'eu-central',
      NL: 'eu-west',
      IT: 'eu-central',
      ES: 'eu-west',
      CN: 'ap-east',
      JP: 'ap-east',
      KR: 'ap-east',
      SG: 'ap-east',
      AU: 'ap-east',
      IN: 'ap-east',
    };

    return mapping[countryCode.toUpperCase()] ?? 'us-east'; // Default to us-east
  }
}
