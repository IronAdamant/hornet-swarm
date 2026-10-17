import type { BrandingConfig } from '@hornet-swarm/core';
import type { ResolvedBrand } from './client-report-model.js';

export const IRON_ADAMANT_NAME = 'Iron Adamant';
export const LOGO_MAX_BYTES = 512 * 1024;

const LOGO_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };

/** Reads a logo file named in a config. The caller resolves the path and refuses links. */
export type LogoReader = (path: string) => Buffer;

export class BrandingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandingError';
  }
}

/**
 * The brand on a report. The job's branding wins field by field over the global config's. Reports
 * are white-label by default, so when `use` is left out the agency's brand is used, and a missing
 * agency name is an error rather than a quiet fall back to Iron Adamant on an agency's report.
 */
export function resolveBrand(job: BrandingConfig | undefined, global: BrandingConfig | undefined, readLogo: LogoReader): ResolvedBrand {
  // A job that names an agency means that agency, even when the global config prefers Iron Adamant.
  const use = job?.use ?? (job?.agency ? 'agency' : undefined) ?? global?.use ?? 'agency';
  if (use === 'agency') {
    const agency = job?.agency ?? global?.agency;
    if (!agency) {
      throw new BrandingError('Reports carry the agency\'s brand by default, and no agency is named. Add branding.agency.name to the job or to ~/.hornet-swarm/config.yaml, or set branding.use: iron_adamant.');
    }
    return withLogo({ prepared_by: 'agency', name: agency.name }, agency, readLogo);
  }
  const details = job?.iron_adamant ?? global?.iron_adamant ?? {};
  return withLogo({ prepared_by: 'iron_adamant', name: IRON_ADAMANT_NAME }, details, readLogo);
}

function withLogo(
  base: Pick<ResolvedBrand, 'prepared_by' | 'name'>,
  details: { logo?: string; logo_alt?: string; website?: string; contact_email?: string; contact_phone?: string },
  readLogo: LogoReader,
): ResolvedBrand {
  const brand: ResolvedBrand = { ...base };
  if (details.website) brand.website = details.website;
  if (details.contact_email) brand.contact_email = details.contact_email;
  if (details.contact_phone) brand.contact_phone = details.contact_phone;
  if (details.logo) {
    const extension = details.logo.split('.').pop()?.toLowerCase() ?? '';
    const type = LOGO_TYPES[extension];
    if (!type) throw new BrandingError(`The logo ${details.logo} is not a PNG, JPEG, or SVG file.`);
    let bytes: Buffer;
    try {
      bytes = readLogo(details.logo);
    } catch (error) {
      throw new BrandingError(`The logo ${details.logo} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (bytes.length > LOGO_MAX_BYTES) throw new BrandingError(`The logo ${details.logo} is over ${LOGO_MAX_BYTES / 1024} KB. Use a smaller file so the report stays easy to email.`);
    brand.logo_data_uri = `data:${type};base64,${bytes.toString('base64')}`;
    brand.logo_alt = details.logo_alt ?? `${base.name} logo`;
  }
  return brand;
}
