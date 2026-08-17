/**
 * Views for the MemberFirst Core stand-in.
 *
 * These templates are intentionally hostile in the way the brief describes:
 * server-rendered, table-based layout, framesets and nested iframes, no test
 * IDs, no ARIA, and form fields whose visible label sits in an adjacent <td>
 * rather than in a <label for=...>. That last detail matters more than it
 * looks: it means most inputs have NO computed accessible name, which is
 * exactly the condition under which naive "get by label" automation fails on
 * legacy enterprise software. Our targeting layer has to earn its keep.
 *
 * Nothing here is styled for looks. It is styled to be period-accurate.
 */

import type { TenantConfig } from './tenants.ts';
import { type Member, type Account, formatUsd } from './data.ts';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BASE_STYLE = `
  body { font-family: Verdana, Arial, sans-serif; font-size: 12px; margin: 0; background: #d4d0c8; color: #111; }
  table { border-collapse: collapse; }
  .shell { width: 100%; }
  .hdr { padding: 8px 10px; font-size: 14px; font-weight: bold; }
  .panel { background: #fff; border: 2px inset #999; margin: 8px; padding: 10px; }
  .grid td, .grid th { border: 1px solid #808080; padding: 4px 8px; font-size: 12px; }
  .grid th { background: #b9c6d8; text-align: left; }
  .fieldlabel { text-align: right; padding: 4px 6px; white-space: nowrap; font-weight: bold; }
  .err { background: #ffe0e0; border: 1px solid #a00; padding: 8px; margin-bottom: 8px; color: #7a0000; }
  .warn { background: #fff6d0; border: 1px solid #b8860b; padding: 8px; margin-bottom: 8px; }
  .ok { background: #e2f7e2; border: 1px solid #2d7a2d; padding: 8px; margin-bottom: 8px; }
  input[type=text], input[type=password], select { font-family: Verdana, sans-serif; font-size: 12px; border: 2px inset #999; padding: 2px; }
  input[type=submit], button { font-family: Verdana, sans-serif; font-size: 12px; padding: 2px 10px; }
  a { color: #00309c; }
`;

function page(title: string, tenant: TenantConfig, body: string, opts: { chrome?: boolean } = {}): string {
  const chrome = opts.chrome !== false;
  return `<!DOCTYPE html>
<html><head><title>${esc(title)} - ${esc(tenant.displayName)}</title><style>${BASE_STYLE}</style></head>
<body>
${chrome ? `<div class="hdr" style="background:${tenant.theme.headerBg};color:${tenant.theme.headerFg}">${esc(tenant.displayName)} <span style="font-weight:normal;font-size:11px">v${esc(tenant.productVersion)}</span></div>` : ''}
${body}
</body></html>`;
}

/* ------------------------------------------------------------------ login */

export function loginPage(tenant: TenantConfig, error?: string): string {
  return page('Sign On', tenant, `
<div class="panel" style="width:420px;margin:40px auto">
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <form method="POST" action="/t/${tenant.id}/session">
    <table>
      <tr><td class="fieldlabel">Operator ID</td><td><input type="text" name="username" size="24"></td></tr>
      <tr><td class="fieldlabel">Password</td><td><input type="password" name="password" size="24"></td></tr>
      <tr><td></td><td style="padding-top:8px"><input type="submit" value="Sign On"></td></tr>
    </table>
  </form>
  <hr>
  <div style="font-size:11px;color:#555">Demo environment. Synthetic data only.</div>
</div>`);
}

/* ----------------------------------------------- post-login acknowledgement */

export function acknowledgementPage(tenant: TenantConfig): string {
  return page('Notice', tenant, `
<div class="panel" style="width:520px;margin:40px auto">
  <div class="warn"><b>Compliance Notice</b><br>
  Access to member records is monitored. Servicing activity is logged under your operator ID.</div>
  <form method="POST" action="/t/${tenant.id}/acknowledge">
    <input type="submit" value="Acknowledge and Continue">
  </form>
</div>`);
}

/* ------------------------------------------------------- interstitial modal */

export function interstitialPage(tenant: TenantConfig, returnTo: string): string {
  // A GET form ignores any query string on its action and rebuilds it from the
  // form's own fields, so the return target has to be split into a path plus
  // hidden inputs. Legacy apps do exactly this, and getting it wrong here would
  // send the operator back to the member screen with no member selected.
  const [path = returnTo, query = ''] = returnTo.split('?');
  const hidden = [...new URLSearchParams(query)]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n    ');

  return page('System Notice', tenant, `
<div class="panel" style="width:520px;margin:40px auto">
  <div class="warn"><b>Scheduled Maintenance Notice</b><br>
  Core processing will be unavailable Sunday 02:00-04:00 ET. Servicing may be slow during nightly posting.</div>
  <form method="GET" action="${esc(path)}">
    ${hidden}
    <input type="submit" value="Continue">
  </form>
</div>`);
}

/* ------------------------------------------------------------- frame shell */

/**
 * A real <frameset>. Deprecated in HTML5 and still rendered by every browser,
 * which is precisely why legacy banking software still ships it. Anything
 * targeting content inside here has to traverse a frame path first.
 */
export function desktopFrameset(tenant: TenantConfig): string {
  return `<!DOCTYPE html>
<html><head><title>${esc(tenant.displayName)}</title></head>
<frameset cols="180,*" border="1">
  <frame name="navFrame" src="/t/${tenant.id}/nav">
  <frame name="mainFrame" src="/t/${tenant.id}/home">
</frameset>
</html>`;
}

export function navFrame(tenant: TenantConfig): string {
  return page('Navigation', tenant, `
<div style="padding:8px">
  <div style="font-weight:bold;border-bottom:1px solid #888;padding-bottom:4px;margin-bottom:6px">Servicing</div>
  <table>
    <tr><td><a href="/t/${tenant.id}/${tenant.routes.search}" target="mainFrame">${esc(tenant.labels.searchNav)}</a></td></tr>
    <tr><td><a href="/t/${tenant.id}/home" target="mainFrame">Home</a></td></tr>
    <tr><td><a href="/t/${tenant.id}/signoff" target="_top">Sign Off</a></td></tr>
  </table>
</div>`, { chrome: false });
}

export function homeFrame(tenant: TenantConfig): string {
  return page('Home', tenant, `
<div class="panel">
  <h3 style="margin-top:0">Servicing Desktop</h3>
  <p>Select a function from the menu on the left.</p>
</div>`, { chrome: false });
}

/* ------------------------------------------------------------ member search */

export function searchPage(tenant: TenantConfig, opts: { error?: string; notice?: string } = {}): string {
  return page('Member Search', tenant, `
<div class="panel">
  <h3 style="margin-top:0">${esc(tenant.labels.searchNav)}</h3>
  ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
  ${opts.notice ? `<div class="warn">${esc(opts.notice)}</div>` : ''}
  <form method="POST" action="/t/${tenant.id}/${tenant.routes.search}">
    <table>
      <tr>
        <td class="fieldlabel">${esc(tenant.labels.memberId)}</td>
        <td><input type="text" name="memberId" size="16" maxlength="10"></td>
      </tr>
      <tr>
        <td class="fieldlabel">${esc(tenant.labels.memberName)}</td>
        <td><input type="text" name="memberName" size="28"></td>
      </tr>
      <tr>
        <td></td>
        <td style="padding-top:8px"><input type="submit" value="${esc(tenant.labels.searchSubmit)}"></td>
      </tr>
    </table>
  </form>
</div>`, { chrome: false });
}

export function searchResultsPage(tenant: TenantConfig, rows: Member[]): string {
  const body = rows
    .map(
      (m) => `<tr>
        <td>${esc(m.id)}</td>
        <td>${esc(m.lastName)}, ${esc(m.firstName)}</td>
        <td>${esc(m.status)}</td>
        <td>${esc(m.branch)}</td>
        <td><a href="/t/${tenant.id}/${tenant.routes.member}?id=${encodeURIComponent(m.id)}">${esc(tenant.labels.viewAction)}</a></td>
      </tr>`,
    )
    .join('\n');

  return page('Search Results', tenant, `
<div class="panel">
  <h3 style="margin-top:0">Search Results</h3>
  <div style="margin-bottom:6px">${rows.length} record(s) returned.</div>
  <table class="grid">
    <tr>
      <th>${esc(tenant.labels.memberId)}</th>
      <th>${esc(tenant.labels.memberName)}</th>
      <th>Status</th>
      <th>Branch</th>
      <th>Action</th>
    </tr>
    ${body}
  </table>
  <p><a href="/t/${tenant.id}/${tenant.routes.search}">New Search</a></p>
</div>`, { chrome: false });
}

export function noResultsPage(tenant: TenantConfig, query: string): string {
  return page('Search Results', tenant, `
<div class="panel">
  <h3 style="margin-top:0">Search Results</h3>
  <div class="warn">No member records matched your search criteria (${esc(query)}).</div>
  <p><a href="/t/${tenant.id}/${tenant.routes.search}">New Search</a></p>
</div>`, { chrome: false });
}

export function permissionDeniedPage(tenant: TenantConfig, memberId: string): string {
  return page('Access Denied', tenant, `
<div class="panel">
  <h3 style="margin-top:0">Access Denied</h3>
  <div class="err">You do not have permission to service member ${esc(memberId)}. This record is restricted.
  Contact your supervisor for an override.</div>
  <p><a href="/t/${tenant.id}/${tenant.routes.search}">New Search</a></p>
</div>`, { chrome: false });
}

/* ------------------------------------------------------------ member detail */

/**
 * The detail page embeds the accounts panel in a NESTED iframe, so the account
 * balance lives two frames deep: mainFrame > panelFrame. Reading it requires
 * traversing a frame path, not just querying the top document.
 */
export function memberDetailPage(tenant: TenantConfig, m: Member): string {
  return page('Member Detail', tenant, `
<div class="panel">
  <h3 style="margin-top:0">Member Detail</h3>
  <table>
    <tr><td class="fieldlabel">${esc(tenant.labels.memberId)}</td><td>${esc(m.id)}</td>
        <td class="fieldlabel">Status</td><td>${esc(m.status)}</td></tr>
    <tr><td class="fieldlabel">${esc(tenant.labels.memberName)}</td><td>${esc(m.firstName)} ${esc(m.lastName)}</td>
        <td class="fieldlabel">Branch</td><td>${esc(m.branch)}</td></tr>
    <tr><td class="fieldlabel">Member Since</td><td>${esc(m.joinedOn)}</td><td></td><td></td></tr>
  </table>
</div>
<div class="panel">
  <b>Accounts</b>
  <iframe name="panelFrame" src="/t/${tenant.id}/member/accounts?id=${encodeURIComponent(m.id)}"
          width="100%" height="200" frameborder="0"></iframe>
</div>
<div class="panel">
  <a href="/t/${tenant.id}/${tenant.routes.subAccountNew}?id=${encodeURIComponent(m.id)}">${esc(tenant.labels.openSubAccount)}</a>
  &nbsp;|&nbsp;
  <a href="/t/${tenant.id}/${tenant.routes.search}">New Search</a>
</div>`, { chrome: false });
}

export function accountsPanel(tenant: TenantConfig, m: Member): string {
  const rows = m.accounts
    .map(
      (a: Account) => `<tr>
        <td>${esc(a.number)}</td>
        <td>${esc(a.type)}</td>
        <td>${esc(a.description)}</td>
        <td align="right">${esc(formatUsd(a.balanceCents))}</td>
      </tr>`,
    )
    .join('\n');

  return page('Accounts', tenant, `
<table class="grid" width="100%">
  <tr><th>Account</th><th>Type</th><th>Description</th><th>${esc(tenant.labels.savingsBalance)}</th></tr>
  ${rows}
</table>`, { chrome: false });
}

/* ---------------------------------------------------------- sub-account form */

export function subAccountFormPage(
  tenant: TenantConfig,
  m: Member,
  opts: { error?: string; values?: Record<string, string> } = {},
): string {
  const v = opts.values ?? {};
  return page('Open Sub-Account', tenant, `
<div class="panel">
  <h3 style="margin-top:0">${esc(tenant.labels.openSubAccount)}</h3>
  ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
  <div style="margin-bottom:8px">Member ${esc(m.id)} &mdash; ${esc(m.firstName)} ${esc(m.lastName)}</div>
  <form method="POST" action="/t/${tenant.id}/sub-account">
    <input type="hidden" name="memberId" value="${esc(m.id)}">
    <table>
      <tr>
        <td class="fieldlabel">${esc(tenant.labels.productType)}</td>
        <td>
          <select name="productType">
            <option value="">-- select --</option>
            <option value="SHARE_SAVINGS"${v['productType'] === 'SHARE_SAVINGS' ? ' selected' : ''}>Share Savings</option>
            <option value="VACATION_CLUB"${v['productType'] === 'VACATION_CLUB' ? ' selected' : ''}>Vacation Club</option>
            <option value="HOLIDAY_CLUB"${v['productType'] === 'HOLIDAY_CLUB' ? ' selected' : ''}>Holiday Club</option>
          </select>
        </td>
      </tr>
      <tr>
        <td class="fieldlabel">${esc(tenant.labels.initialDeposit)}</td>
        <td><input type="text" name="initialDeposit" size="12" value="${esc(v['initialDeposit'] ?? '')}"> (USD)</td>
      </tr>
      <tr>
        <td class="fieldlabel">Nickname</td>
        <td><input type="text" name="nickname" size="24" value="${esc(v['nickname'] ?? '')}"></td>
      </tr>
      <tr>
        <td></td>
        <td style="padding-top:8px">
          <input type="submit" value="${esc(tenant.labels.submitSubAccount)}">
          &nbsp;<a href="/t/${tenant.id}/${tenant.routes.member}?id=${encodeURIComponent(m.id)}">Cancel</a>
        </td>
      </tr>
    </table>
  </form>
  <div style="font-size:11px;color:#555;margin-top:8px">
    Minimum opening deposit: ${esc(formatUsd(tenant.minimumDepositCents))}
  </div>
</div>`, { chrome: false });
}

export function subAccountConfirmationPage(
  tenant: TenantConfig,
  m: Member,
  acct: { number: string; product: string; depositUsd: string },
): string {
  return page('Confirmation', tenant, `
<div class="panel">
  <h3 style="margin-top:0">Sub-Account Opened</h3>
  <div class="ok">Account created successfully. Confirmation reference ${esc(acct.number)}.</div>
  <table>
    <tr><td class="fieldlabel">New Account Number</td><td>${esc(acct.number)}</td></tr>
    <tr><td class="fieldlabel">${esc(tenant.labels.memberId)}</td><td>${esc(m.id)}</td></tr>
    <tr><td class="fieldlabel">${esc(tenant.labels.productType)}</td><td>${esc(acct.product)}</td></tr>
    <tr><td class="fieldlabel">${esc(tenant.labels.initialDeposit)}</td><td>${esc(acct.depositUsd)}</td></tr>
  </table>
  <p><a href="/t/${tenant.id}/${tenant.routes.member}?id=${encodeURIComponent(m.id)}">Return to Member</a></p>
</div>`, { chrome: false });
}

/* -------------------------------------------------------------- error pages */

export function sessionExpiredPage(tenant: TenantConfig): string {
  return page('Session Expired', tenant, `
<div class="panel" style="width:420px;margin:40px auto">
  <div class="err">Your session has expired due to inactivity. Please sign on again.</div>
  <p><a href="/t/${tenant.id}/" target="_top">Return to Sign On</a></p>
</div>`);
}

export function appErrorPage(tenant: TenantConfig, ref: string): string {
  return page('System Error', tenant, `
<div class="panel">
  <div class="err"><b>Unexpected system error.</b><br>
  The transaction could not be completed. Reference ${esc(ref)}.<br>
  Contact the service desk if this persists.</div>
</div>`, { chrome: false });
}
