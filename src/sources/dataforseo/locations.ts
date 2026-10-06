// GSC ISO-3 country -> DataForSEO location and language (assets/country-locations.json). Owner: WP-D.
//
// Search Console reports countries as lowercase ISO 3166-1 alpha-3 codes ('gbr'). DataForSEO
// country location codes are 2000 + the ISO numeric code (United Kingdom 826 -> 2826). The
// asset holds only countries whose main Google search language we are sure of; anything else
// needs serp.locationCode and serp.languageCode in config.json, and the poster says so.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { StError } from '../../core/errors.js';

export interface DfsLocation {
  iso2: string;
  locationCode: number;
  languageCode: string;
}

const LocationSchema = z.object({
  iso2: z.string().regex(/^[A-Z]{2}$/),
  locationCode: z.number().int().min(2000).max(2999),
  languageCode: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
});
const AssetSchema = z.object({ rule: z.string(), countries: z.record(z.string().regex(/^[a-z]{3}$/), LocationSchema) });

let table: ReadonlyMap<string, DfsLocation> | null = null;

/** The parsed asset, read once. Works from src/ (tests) and dist/ (the package): both sit two levels below the root. */
export function locationTable(): ReadonlyMap<string, DfsLocation> {
  if (table) return table;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(new URL('../../../assets/country-locations.json', import.meta.url), 'utf8'));
  } catch (e) {
    throw new StError('internal', 'Could not read assets/country-locations.json.', undefined, { cause: e });
  }
  const parsed = AssetSchema.safeParse(raw);
  if (!parsed.success) throw new StError('internal', 'assets/country-locations.json is not valid.');
  table = new Map(Object.entries(parsed.data.countries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return table;
}

/** Location and language for a Search Console country code ('gbr'), or null when we don't know it. */
export function locationForCountry(iso3: string): DfsLocation | null {
  const key = String(iso3 ?? '').trim().toLowerCase();
  const hit = locationTable().get(key);
  return hit ? { ...hit } : null;
}

export interface ResolvedLocation {
  locationCode: number;
  languageCode: string;
  /** Where the location came from: config.json, or the top Search Console country. */
  source: 'config' | 'country';
  country: string | null;
}

/**
 * serp.locationCode wins; otherwise the top country by impressions. The language comes from
 * serp.languageCode, else the country table, else (a configured location with no language) 'en'.
 * Null when neither config nor the table can name a location.
 */
export function resolveLocation(
  serp: { locationCode?: number; languageCode?: string },
  topCountry: string | null,
): ResolvedLocation | null {
  const fromCountry = topCountry ? locationForCountry(topCountry) : null;
  if (serp.locationCode !== undefined) {
    const byCode = [...locationTable().values()].find((l) => l.locationCode === serp.locationCode) ?? null;
    return {
      locationCode: serp.locationCode,
      languageCode: serp.languageCode ?? byCode?.languageCode ?? fromCountry?.languageCode ?? 'en',
      source: 'config',
      country: topCountry,
    };
  }
  if (!fromCountry) return null;
  return {
    locationCode: fromCountry.locationCode,
    languageCode: serp.languageCode ?? fromCountry.languageCode,
    source: 'country',
    country: topCountry,
  };
}
