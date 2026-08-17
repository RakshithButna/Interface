/**
 * Two tenants running the SAME vendor product ("MemberFirst Core"), configured,
 * branded and versioned differently -- the situation described in Section 1 of
 * the brief, where hundreds of institutions run ~20 apps each and many share an
 * underlying vendor product.
 *
 * Everything that differs between tenants lives in this file. The route
 * handlers and view templates are shared. That is deliberate: it mirrors how a
 * real vendor ships one product and configures it per institution, and it means
 * the cross-tenant replay demo is exercising genuine configuration drift rather
 * than two hand-written apps that happen to look similar.
 */

export interface TenantConfig {
  id: string;
  displayName: string;
  productVersion: string;
  /** Branding, which changes accessible names throughout the UI. */
  theme: { headerBg: string; headerFg: string };
  /** Field and column labels. Legacy apps relabel freely between installs. */
  labels: {
    memberId: string;
    memberName: string;
    savingsBalance: string;
    searchNav: string;
    searchSubmit: string;
    viewAction: string;
    openSubAccount: string;
    initialDeposit: string;
    productType: string;
    submitSubAccount: string;
  };
  /** Route slugs differ between installs of the same product. */
  routes: {
    search: string;
    member: string;
    subAccountNew: string;
  };
  /** Tenant B forces a compliance acknowledgement after login. */
  requiresLoginAcknowledgement: boolean;
  /** Minimum opening deposit, in cents. Differs by institution policy. */
  minimumDepositCents: number;
  credentials: { username: string; password: string };
}

export const TENANTS: Record<string, TenantConfig> = {
  westside: {
    id: 'westside',
    displayName: 'MemberFirst Core',
    productVersion: '7.2.1',
    theme: { headerBg: '#1f3a5f', headerFg: '#ffffff' },
    labels: {
      memberId: 'Member ID',
      memberName: 'Member Name',
      savingsBalance: 'Savings Balance',
      searchNav: 'Member Search',
      searchSubmit: 'Search',
      viewAction: 'View',
      openSubAccount: 'Open Sub-Account',
      initialDeposit: 'Initial Deposit',
      productType: 'Product Type',
      submitSubAccount: 'Open Account',
    },
    routes: {
      search: 'member-search',
      member: 'member',
      subAccountNew: 'sub-account/new',
    },
    requiresLoginAcknowledgement: false,
    minimumDepositCents: 2500,
    credentials: { username: 'svc_agent', password: 'demo-only-not-a-real-secret' },
  },

  lakeshore: {
    id: 'lakeshore',
    displayName: 'Lakeshore CU — Core Servicing',
    productVersion: '6.9.4',
    theme: { headerBg: '#4a1f1f', headerFg: '#ffe9e9' },
    labels: {
      // Same fields, different words. This is what breaks naive
      // accessible-name targeting across tenants, and what the artifact's
      // per-tenant override map exists to absorb.
      memberId: 'Membership Number',
      memberName: 'Name on Record',
      savingsBalance: 'Savings Bal.',
      searchNav: 'Find Member',
      searchSubmit: 'Find',
      viewAction: 'Open',
      openSubAccount: 'Add Sub-Account',
      initialDeposit: 'Opening Deposit',
      productType: 'Account Product',
      submitSubAccount: 'Create Account',
    },
    routes: {
      search: 'members/find',
      member: 'members/detail',
      subAccountNew: 'members/sub-account',
    },
    requiresLoginAcknowledgement: true,
    minimumDepositCents: 5000,
    credentials: { username: 'svc_agent', password: 'demo-only-not-a-real-secret' },
  },
};

export const DEFAULT_TENANT = 'westside';

export function getTenant(id: string | undefined): TenantConfig | undefined {
  if (!id) return undefined;
  return TENANTS[id];
}
