/**
 * Fixture data for the MemberFirst Core stand-in app.
 *
 * All of it is synthetic. No real PII, no real account numbers, no real
 * institution. The brief forbids real credentials/PII and we take that
 * literally: nothing here corresponds to a real person or institution.
 */

export type MemberStatus = 'ACTIVE' | 'DORMANT' | 'RESTRICTED';

export interface Account {
  number: string;
  type: 'SAVINGS' | 'CHECKING' | 'CERTIFICATE';
  description: string;
  balanceCents: number;
  openedOn: string;
}

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  status: MemberStatus;
  branch: string;
  joinedOn: string;
  accounts: Account[];
}

export const MEMBERS: Member[] = [
  {
    id: '12345',
    firstName: 'Dana',
    lastName: 'Whitfield',
    status: 'ACTIVE',
    branch: 'Westside Main',
    joinedOn: '2014-03-11',
    accounts: [
      { number: '12345-00', type: 'SAVINGS', description: 'Primary Share Savings', balanceCents: 428_137, openedOn: '2014-03-11' },
      { number: '12345-10', type: 'CHECKING', description: 'Free Checking', balanceCents: 91_204, openedOn: '2016-08-02' },
    ],
  },
  {
    id: '22887',
    firstName: 'Marcus',
    lastName: 'Oyelaran',
    status: 'ACTIVE',
    branch: 'Northgate',
    joinedOn: '2019-11-26',
    accounts: [
      { number: '22887-00', type: 'SAVINGS', description: 'Primary Share Savings', balanceCents: 1_502_990, openedOn: '2019-11-26' },
      { number: '22887-40', type: 'CERTIFICATE', description: '18-Month Certificate', balanceCents: 2_500_000, openedOn: '2023-01-09' },
    ],
  },
  {
    id: '30001',
    firstName: 'Priya',
    lastName: 'Raghunathan',
    status: 'RESTRICTED',
    branch: 'Westside Main',
    joinedOn: '2008-05-19',
    accounts: [
      { number: '30001-00', type: 'SAVINGS', description: 'Primary Share Savings', balanceCents: 77_010, openedOn: '2008-05-19' },
    ],
  },
  {
    id: '41120',
    firstName: 'Dana',
    lastName: 'Whitfield-Cruz',
    status: 'DORMANT',
    branch: 'Southbank',
    joinedOn: '2021-07-04',
    accounts: [
      { number: '41120-00', type: 'SAVINGS', description: 'Primary Share Savings', balanceCents: 1_255, openedOn: '2021-07-04' },
    ],
  },
];

export function findMemberById(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id.trim());
}

/**
 * Surname search deliberately returns multiple rows for "Whitfield" so that
 * the results table has more than one identically-labelled "View" link.
 * That ambiguity is the point: text-only targeting cannot resolve it, and the
 * replay engine has to fall back to row-anchored resolution.
 */
export function findMembersByName(q: string): Member[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return MEMBERS.filter(
    (m) =>
      m.lastName.toLowerCase().includes(needle) ||
      m.firstName.toLowerCase().includes(needle) ||
      `${m.firstName} ${m.lastName}`.toLowerCase().includes(needle),
  );
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Sub-accounts opened during a session. In-memory only; reset on restart. */
export const OPENED_SUB_ACCOUNTS: Array<{ memberId: string; number: string; product: string; openedAt: string }> = [];

let subAccountSeq = 70;
export function nextSubAccountNumber(memberId: string): string {
  subAccountSeq += 1;
  return `${memberId}-${subAccountSeq}`;
}
