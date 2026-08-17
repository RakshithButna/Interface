/**
 * Where per-tenant specialization lives.
 *
 * Overrides can come from two places, and the split is the interesting part of
 * the multi-tenant answer:
 *
 *   config/tenants/<productId>/<tenantId>.json
 *       Per PRODUCT + TENANT. Applies to every capability recorded against that
 *       product. This is where the common case belongs -- an institution that
 *       renamed "Member ID" to "Membership Number" renamed it everywhere, in
 *       every flow. One file, edited once.
 *
 *   artifact.overrides[]
 *       Per CAPABILITY + TENANT. For the rare quirk that affects one flow at
 *       one institution and nothing else.
 *
 * The product-level file is the load-bearing one. With hundreds of tenants and
 * ~20 apps each, the thing that must not scale linearly is the work required
 * when a tenant rebrands or upgrades. If that work is proportional to the
 * number of RECORDED FLOWS rather than the number of tenants, the system
 * collapses under its own maintenance. Keeping the common case in one file per
 * tenant is what prevents that.
 *
 * The artifact-level override wins on conflict, on the principle that the more
 * specific declaration should.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TenantOverrideSchema, type TenantOverride } from '../schema/artifact.ts';

export function loadTenantOverride(
  productId: string,
  tenantId: string,
  root = 'config/tenants',
): TenantOverride | undefined {
  const path = join(root, productId, `${tenantId}.json`);
  if (!existsSync(path)) return undefined;
  return TenantOverrideSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Tenants with a configured override for a product. For `catalog` output. */
export function listConfiguredTenants(productId: string, root = 'config/tenants'): string[] {
  const dir = join(root, productId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/**
 * Merge a product-level override with a capability-level one.
 * `specific` wins field by field; the alias maps are merged rather than
 * replaced, so a capability-level override adds to the tenant's vocabulary
 * instead of discarding it.
 */
export function mergeOverrides(
  base: TenantOverride | undefined,
  specific: TenantOverride | undefined,
): TenantOverride | undefined {
  if (!base) return specific;
  if (!specific) return base;

  return {
    tenantId: specific.tenantId,
    ...(specific.note ?? base.note ? { note: [base.note, specific.note].filter(Boolean).join(' | ') } : {}),
    ...(specific.baseUrl ?? base.baseUrl ? { baseUrl: specific.baseUrl ?? base.baseUrl } : {}),
    labelAliases: { ...base.labelAliases, ...specific.labelAliases },
    routeAliases: { ...base.routeAliases, ...specific.routeAliases },
    disableSteps: [...new Set([...base.disableSteps, ...specific.disableSteps])],
    insertSteps: [...base.insertSteps, ...specific.insertSteps],
    extraRecoveries: [...base.extraRecoveries, ...specific.extraRecoveries],
  };
}
