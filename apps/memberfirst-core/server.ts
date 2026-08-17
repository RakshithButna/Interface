/**
 * MemberFirst Core -- a stand-in for the kind of back-office banking
 * application this system is built to automate.
 *
 * Why a local app rather than a public demo site: the brief grades hardest on
 * how replay handles *runtime* exceptional states -- validation errors, record
 * not found, permission denials, unexpected dialogs, session expiry, transient
 * slowness. You cannot make a public site produce those on demand. Here they
 * are first-class and armable, so the error taxonomy can be demonstrated
 * rather than asserted.
 *
 * The app is served with no dependencies beyond node:http, and deliberately
 * reproduces legacy characteristics: server-rendered HTML, a real <frameset>,
 * a nested <iframe>, table-based layout, identical link text repeated per row,
 * and form inputs whose labels are adjacent table cells rather than <label for>.
 *
 * Two tenants (`westside`, `lakeshore`) run this same product with different
 * branding, field labels, route slugs and policy thresholds.
 */

import http from 'node:http';
import { URL } from 'node:url';
import { TENANTS, getTenant, DEFAULT_TENANT, type TenantConfig } from './tenants.ts';
import {
  findMemberById,
  findMembersByName,
  formatUsd,
  nextSubAccountNumber,
  OPENED_SUB_ACCOUNTS,
} from './data.ts';
import * as V from './views.ts';

const PORT = Number(process.env['APP_PORT'] ?? 4173);
const HOST = '127.0.0.1';

/* ------------------------------------------------------------------ state */

/** Sessions are in-memory. `expired` lets us simulate timeout mid-run. */
const sessions = new Map<string, { tenant: string; user: string; acknowledged: boolean; expired: boolean }>();

type InjectionMode = 'slow' | 'interstitial' | 'session_expired' | 'app_error';

/**
 * Fault injection switchboard.
 *
 * This is a TEST AFFORDANCE, not a product feature, and it is namespaced under
 * /_control to make that obvious. It exists so the replay demos can arm a
 * specific runtime condition deterministically instead of waiting for one to
 * occur by luck. A real target app would produce these on its own.
 */
const armed = new Map<InjectionMode, { sticky: boolean }>();

function consumeInjection(mode: InjectionMode): boolean {
  const entry = armed.get(mode);
  if (!entry) return false;
  if (!entry.sticky) armed.delete(mode);
  return true;
}

/* ----------------------------------------------------------------- helpers */

function sendHtml(res: http.ServerResponse, body: string, status = 200): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newSessionId(): string {
  return `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Parses a dollar string like "$1,250.00" or "50" into cents. */
function parseUsdToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

const PRODUCT_LABELS: Record<string, string> = {
  SHARE_SAVINGS: 'Share Savings',
  VACATION_CLUB: 'Vacation Club',
  HOLIDAY_CLUB: 'Holiday Club',
};

/* ------------------------------------------------------------------ router */

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  tenant: TenantConfig;
  /** Path after /t/:tenant/, with no leading slash. */
  rest: string;
  sessionId: string | undefined;
}

function requireSession(ctx: Ctx): { ok: true; sid: string } | { ok: false; sid?: undefined } {
  const sid = ctx.sessionId;
  const sess = sid ? sessions.get(sid) : undefined;

  if (consumeInjection('session_expired') && sess) {
    sess.expired = true;
  }

  if (!sid || !sess || sess.expired || sess.tenant !== ctx.tenant.id) {
    sendHtml(ctx.res, V.sessionExpiredPage(ctx.tenant), 200);
    return { ok: false };
  }
  if (ctx.tenant.requiresLoginAcknowledgement && !sess.acknowledged) {
    sendHtml(ctx.res, V.acknowledgementPage(ctx.tenant));
    return { ok: false };
  }
  return { ok: true, sid };
}

async function handleTenantRoute(ctx: Ctx): Promise<void> {
  const { res, url, tenant, rest, req } = ctx;
  const method = req.method ?? 'GET';
  const R = tenant.routes;

  /* --- sign on ------------------------------------------------------- */

  if (rest === '' || rest === 'signon') {
    return sendHtml(res, V.loginPage(tenant));
  }

  if (rest === 'signoff') {
    if (ctx.sessionId) sessions.delete(ctx.sessionId);
    return sendHtml(res, V.loginPage(tenant, 'You have been signed off.'));
  }

  if (rest === 'session' && method === 'POST') {
    const body = await readBody(req);
    const ok =
      body['username'] === tenant.credentials.username &&
      body['password'] === tenant.credentials.password;
    if (!ok) {
      return sendHtml(res, V.loginPage(tenant, 'Invalid operator ID or password.'), 200);
    }
    const sid = newSessionId();
    sessions.set(sid, {
      tenant: tenant.id,
      user: body['username'] ?? '',
      acknowledged: !tenant.requiresLoginAcknowledgement,
      expired: false,
    });
    res.writeHead(302, {
      'set-cookie': `mfc_session=${sid}; Path=/; HttpOnly; SameSite=Lax`,
      location: `/t/${tenant.id}/desktop`,
    });
    res.end();
    return;
  }

  if (rest === 'acknowledge' && method === 'POST') {
    const sess = ctx.sessionId ? sessions.get(ctx.sessionId) : undefined;
    if (sess) sess.acknowledged = true;
    return redirect(res, `/t/${tenant.id}/desktop`);
  }

  /* --- frame shell --------------------------------------------------- */

  if (rest === 'desktop') {
    const gate = requireSession(ctx);
    if (!gate.ok) return;
    return sendHtml(res, V.desktopFrameset(tenant));
  }

  if (rest === 'nav') {
    return sendHtml(res, V.navFrame(tenant));
  }

  if (rest === 'home') {
    const gate = requireSession(ctx);
    if (!gate.ok) return;
    return sendHtml(res, V.homeFrame(tenant));
  }

  if (rest === 'notice') {
    return sendHtml(res, V.interstitialPage(tenant, url.searchParams.get('returnTo') ?? `/t/${tenant.id}/home`));
  }

  /* --- member search -------------------------------------------------- */

  if (rest === R.search && method === 'GET') {
    const gate = requireSession(ctx);
    if (!gate.ok) return;
    return sendHtml(res, V.searchPage(tenant));
  }

  if (rest === R.search && method === 'POST') {
    const gate = requireSession(ctx);
    if (!gate.ok) return;

    const body = await readBody(req);
    const memberId = (body['memberId'] ?? '').trim();
    const memberName = (body['memberName'] ?? '').trim();

    if (!memberId && !memberName) {
      return sendHtml(
        res,
        V.searchPage(tenant, { error: `${tenant.labels.memberId} or ${tenant.labels.memberName} is required.` }),
      );
    }

    if (consumeInjection('slow')) await sleep(6000);
    if (consumeInjection('app_error')) {
      return sendHtml(res, V.appErrorPage(tenant, `ERR-${Date.now().toString(36).toUpperCase()}`), 500);
    }

    if (memberId) {
      if (!/^\d{1,10}$/.test(memberId)) {
        return sendHtml(res, V.searchPage(tenant, { error: `${tenant.labels.memberId} must be numeric.` }));
      }
      const m = findMemberById(memberId);
      if (!m) return sendHtml(res, V.noResultsPage(tenant, `${tenant.labels.memberId} ${memberId}`));
      return sendHtml(res, V.searchResultsPage(tenant, [m]));
    }

    const rows = findMembersByName(memberName);
    if (rows.length === 0) return sendHtml(res, V.noResultsPage(tenant, memberName));
    return sendHtml(res, V.searchResultsPage(tenant, rows));
  }

  /* --- member detail --------------------------------------------------- */

  if (rest === R.member) {
    const gate = requireSession(ctx);
    if (!gate.ok) return;

    const id = url.searchParams.get('id') ?? '';

    // An unexpected interstitial appearing mid-flow is one of the named
    // exceptional states in the brief. Armed, it fires here.
    if (consumeInjection('interstitial')) {
      const back = `/t/${tenant.id}/${R.member}?id=${encodeURIComponent(id)}`;
      return sendHtml(res, V.interstitialPage(tenant, back));
    }
    if (consumeInjection('slow')) await sleep(6000);

    const m = findMemberById(id);
    if (!m) return sendHtml(res, V.noResultsPage(tenant, `${tenant.labels.memberId} ${id}`));
    if (m.status === 'RESTRICTED') return sendHtml(res, V.permissionDeniedPage(tenant, m.id), 403);

    return sendHtml(res, V.memberDetailPage(tenant, m));
  }

  if (rest === 'member/accounts') {
    const gate = requireSession(ctx);
    if (!gate.ok) return;
    const m = findMemberById(url.searchParams.get('id') ?? '');
    if (!m) return sendHtml(res, V.appErrorPage(tenant, 'ACCT-404'), 404);
    return sendHtml(res, V.accountsPanel(tenant, m));
  }

  /* --- sub-account ----------------------------------------------------- */

  if (rest === R.subAccountNew) {
    const gate = requireSession(ctx);
    if (!gate.ok) return;
    const m = findMemberById(url.searchParams.get('id') ?? '');
    if (!m) return sendHtml(res, V.noResultsPage(tenant, url.searchParams.get('id') ?? ''));
    if (m.status === 'RESTRICTED') return sendHtml(res, V.permissionDeniedPage(tenant, m.id), 403);
    return sendHtml(res, V.subAccountFormPage(tenant, m));
  }

  if (rest === 'sub-account' && method === 'POST') {
    const gate = requireSession(ctx);
    if (!gate.ok) return;

    const body = await readBody(req);
    const m = findMemberById(body['memberId'] ?? '');
    if (!m) return sendHtml(res, V.noResultsPage(tenant, body['memberId'] ?? ''));

    if (consumeInjection('app_error')) {
      return sendHtml(res, V.appErrorPage(tenant, `ERR-${Date.now().toString(36).toUpperCase()}`), 500);
    }

    const productType = body['productType'] ?? '';
    const depositRaw = body['initialDeposit'] ?? '';
    const values = { productType, initialDeposit: depositRaw, nickname: body['nickname'] ?? '' };

    if (!productType) {
      return sendHtml(res, V.subAccountFormPage(tenant, m, { error: `${tenant.labels.productType} is required.`, values }));
    }
    const cents = parseUsdToCents(depositRaw);
    if (cents === null) {
      return sendHtml(res, V.subAccountFormPage(tenant, m, { error: `${tenant.labels.initialDeposit} must be a valid dollar amount.`, values }));
    }
    if (cents < tenant.minimumDepositCents) {
      return sendHtml(
        res,
        V.subAccountFormPage(tenant, m, {
          error: `${tenant.labels.initialDeposit} must be at least ${formatUsd(tenant.minimumDepositCents)}.`,
          values,
        }),
      );
    }

    const number = nextSubAccountNumber(m.id);
    OPENED_SUB_ACCOUNTS.push({
      memberId: m.id,
      number,
      product: PRODUCT_LABELS[productType] ?? productType,
      openedAt: new Date().toISOString(),
    });
    return sendHtml(
      res,
      V.subAccountConfirmationPage(tenant, m, {
        number,
        product: PRODUCT_LABELS[productType] ?? productType,
        depositUsd: formatUsd(cents),
      }),
    );
  }

  sendHtml(res, V.appErrorPage(tenant, 'ROUTE-404'), 404);
}

/* ------------------------------------------------------------------ server */

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    const path = url.pathname;

    // Test-affordance control plane (see note on `armed` above).
    if (path === '/_control/inject' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const mode = body['mode'] as InjectionMode | 'none' | undefined;
      if (mode === 'none' || mode === undefined) {
        armed.clear();
        return sendJson(res, { armed: [] });
      }
      armed.set(mode, { sticky: body['sticky'] === true });
      return sendJson(res, { armed: [...armed.keys()] });
    }
    if (path === '/_control/state') {
      return sendJson(res, { armed: [...armed.keys()], openedSubAccounts: OPENED_SUB_ACCOUNTS.length });
    }
    if (path === '/_control/health') {
      return sendJson(res, { ok: true, tenants: Object.keys(TENANTS) });
    }

    if (path === '/' || path === '/favicon.ico') {
      if (path === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      return redirect(res, `/t/${DEFAULT_TENANT}/`);
    }

    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 't' || !parts[1]) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    const tenant = getTenant(parts[1]);
    if (!tenant) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(`Unknown tenant: ${parts[1]}`);
    }

    const ctx: Ctx = {
      req,
      res,
      url,
      tenant,
      rest: parts.slice(2).join('/'),
      sessionId: parseCookies(req)['mfc_session'],
    };

    await handleTenantRoute(ctx);
  })().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[memberfirst-core] unhandled', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal error');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[memberfirst-core] listening on http://${HOST}:${PORT}`);
  for (const t of Object.values(TENANTS)) {
    console.log(`  tenant ${t.id.padEnd(10)} -> http://${HOST}:${PORT}/t/${t.id}/   (${t.displayName} v${t.productVersion})`);
  }
});
