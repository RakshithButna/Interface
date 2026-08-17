/**
 * The operator console.
 *
 * Scope note, stated plainly because the brief asks for it: this is the
 * deliberately minimal part. A production co-browsing console would stream the
 * session, authenticate the operator, scope them to a tenant, queue work across
 * a team, and record video. None of that is here.
 *
 * What IS real is the part that matters for the design question: the control
 * transfer. The human drives the actual live Chromium window the automation was
 * using -- same context, same cookies, same server-side session, same page
 * scrolled to the same place. The console does not proxy input or reconstruct
 * state; it hands over the lease and gets out of the way. Handing back resumes
 * the same run on the same session.
 *
 * The screenshot here is a convenience for seeing what the automation stopped
 * on, and for confirming the window you are typing into is the right one. It is
 * not the control channel. The control channel is the browser window itself,
 * which is why runs that may need a human are launched headed.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionController, InterventionRequest } from './session-control.ts';
import type { Surface } from '../surface/types.ts';

export interface OperatorConsoleOptions {
  port?: number;
  controller: SessionController;
  /** Resolved lazily: the surface may not exist when the console starts. */
  getSurface: () => Surface | undefined;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; background: #f6f7f9; color: #14161a; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e8eaed; } }
  header { background: #1f3a5f; color: #fff; padding: 14px 20px; font-weight: 600; }
  main { max-width: 1000px; margin: 0 auto; padding: 20px; }
  .card { background: #fff; border: 1px solid #d8dce2; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  @media (prefers-color-scheme: dark) { .card { background: #1e2126; border-color: #333840; } }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .open { background: #ffe8cc; color: #8a4b00; }
  .human { background: #d8e8ff; color: #123a72; }
  .resumed { background: #d8f5d8; color: #1c5c1c; }
  .aborted { background: #ffd9d9; color: #7a1414; }
  dl { display: grid; grid-template-columns: 190px 1fr; gap: 6px 14px; margin: 0; }
  dt { font-weight: 600; color: #5a6270; }
  dd { margin: 0; word-break: break-word; }
  img.shot { width: 100%; border: 1px solid #d8dce2; border-radius: 6px; }
  button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; margin-right: 8px; }
  .primary { background: #1f6feb; color: #fff; }
  .danger { background: #b62324; color: #fff; }
  .ghost { background: transparent; border-color: #9aa2ae; color: inherit; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e3e6ea; }
  code { background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; }
  a { color: #1f6feb; }
  .muted { color: #6b7280; font-size: 13px; }
`;

function statusBadge(i: InterventionRequest): string {
  const cls =
    i.status === 'open' ? 'open' : i.status === 'human_in_control' ? 'human' : i.status === 'resumed' ? 'resumed' : 'aborted';
  return `<span class="badge ${cls}">${esc(i.status.replace(/_/g, ' '))}</span>`;
}

function layout(title: string, body: string, refresh = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  ${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
  <style>${STYLE}</style></head>
  <body><header>Operator Console &mdash; computer-use automation</header><main>${body}</main></body></html>`;
}

function listPage(controller: SessionController): string {
  const items = controller.list();
  const open = items.filter((i) => !i.resolution);

  const rows = items
    .map(
      (i) => `<tr>
        <td><a href="/i/${esc(i.id)}"><code>${esc(i.id)}</code></a></td>
        <td>${statusBadge(i)}</td>
        <td>${esc(i.kind.replace(/_/g, ' '))}</td>
        <td>${esc(i.capability ?? i.goal.slice(0, 50))}</td>
        <td>${esc(i.reason.slice(0, 80))}</td>
        <td class="muted">${esc(i.createdAt.slice(11, 19))}</td>
      </tr>`,
    )
    .join('');

  return layout(
    'Interventions',
    `<div class="card">
      <p><b>Control is held by:</b> <code>${esc(controller.controlledBy)}</code></p>
      <p class="muted">${open.length} open intervention(s). This page refreshes automatically.</p>
    </div>
    <div class="card">
      ${
        items.length === 0
          ? '<p class="muted">No intervention requests yet. Start a run that gets stuck or hits a risky step.</p>'
          : `<table><tr><th>ID</th><th>Status</th><th>Kind</th><th>Capability</th><th>Reason</th><th>At</th></tr>${rows}</table>`
      }
    </div>`,
    true,
  );
}

function detailPage(i: InterventionRequest, controller: SessionController): string {
  const actions = i.humanActions
    .map(
      (a) => `<tr>
        <td class="muted">${esc(a.ts.slice(11, 19))}</td>
        <td>${esc(a.type)}</td>
        <td>${esc(a.frame ?? '')}</td>
        <td><code>${esc(a.control ?? a.url ?? '')}</code></td>
        <td>${esc(a.value ?? '')}</td>
      </tr>`,
    )
    .join('');

  const controls = i.resolution
    ? `<p class="muted">Resolved as <b>${esc(i.resolution)}</b> at ${esc(i.resolvedAt ?? '')}.
       ${i.operatorNote ? `Note: ${esc(i.operatorNote)}` : ''}</p>`
    : `<form method="POST" action="/i/${esc(i.id)}/take" style="display:inline">
         <button class="ghost" ${i.status === 'human_in_control' ? 'disabled' : ''}>Take control</button>
       </form>
       <form method="POST" action="/i/${esc(i.id)}/resume" style="display:inline">
         <input type="hidden" name="note" value="">
         <button class="primary">Hand back &amp; resume</button>
       </form>
       <form method="POST" action="/i/${esc(i.id)}/abort" style="display:inline">
         <button class="danger">Abort run</button>
       </form>
       <p class="muted" style="margin-top:12px">
         Take control, then switch to the Chromium window the automation opened and complete the step by hand.
         It is the same live session &mdash; same cookies, same server-side session, same open record.
         Everything you click is recorded below. Hand back when you are done.
       </p>`;

  return layout(
    `Intervention ${i.id}`,
    `<p><a href="/">&larr; All interventions</a></p>
    <div class="card">
      <h2 style="margin-top:0">${statusBadge(i)} &nbsp;<code>${esc(i.id)}</code></h2>
      <dl>
        <dt>Why it stopped</dt><dd><b>${esc(i.reason)}</b></dd>
        ${i.detail ? `<dt>Detail</dt><dd>${esc(i.detail)}</dd>` : ''}
        <dt>Kind</dt><dd>${esc(i.kind.replace(/_/g, ' '))}</dd>
        <dt>Capability</dt><dd>${esc(i.capability ? `${i.capability}@${i.capabilityVersion}` : '(discovery run)')}</dd>
        <dt>Goal</dt><dd>${esc(i.goal)}</dd>
        <dt>Tenant</dt><dd><code>${esc(i.tenantId)}</code></dd>
        ${i.stepId ? `<dt>Step</dt><dd><code>${esc(i.stepId)}</code> &mdash; ${esc(i.stepIntent ?? '')}</dd>` : ''}
        <dt>Current URL</dt><dd><code>${esc(i.currentUrl)}</code></dd>
        <dt>Run</dt><dd><code>${esc(i.runId)}</code></dd>
        <dt>Control held by</dt><dd><code>${esc(controller.controlledBy)}</code></dd>
      </dl>
    </div>
    <div class="card">${controls}</div>
    <div class="card">
      <h3 style="margin-top:0">Live session</h3>
      <img class="shot" src="/i/${esc(i.id)}/shot.png?t=${Date.now()}" alt="current screen">
    </div>
    <div class="card">
      <h3 style="margin-top:0">Human actions recorded (${i.humanActions.length})</h3>
      ${
        i.humanActions.length === 0
          ? '<p class="muted">Nothing yet. Actions you take in the live browser window appear here.</p>'
          : `<table><tr><th>Time</th><th>Type</th><th>Frame</th><th>Control</th><th>Value</th></tr>${actions}</table>`
      }
    </div>`,
    !i.resolution,
  );
}

export interface RunningConsole {
  url: string;
  close: () => Promise<void>;
}

export async function startOperatorConsole(opts: OperatorConsoleOptions): Promise<RunningConsole> {
  const { controller, getSurface } = opts;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      const send = (body: string, status = 200, type = 'text/html; charset=utf-8') => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      };

      if (path === '/' && method === 'GET') return send(listPage(controller));

      if (path === '/api/interventions' && method === 'GET') {
        return send(JSON.stringify(controller.list(), null, 2), 200, 'application/json');
      }

      const m = /^\/i\/([^/]+)(\/[a-z.]+)?$/.exec(path);
      if (!m) return send(layout('Not found', '<div class="card">Not found.</div>'), 404);

      const id = m[1]!;
      const sub = m[2] ?? '';
      const intervention = controller.get(id);
      if (!intervention) return send(layout('Not found', '<div class="card">No such intervention.</div>'), 404);

      if (sub === '/shot.png' && method === 'GET') {
        const surface = getSurface();
        const png = surface ? await surface.screenshot() : null;
        if (!png) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          return res.end('No live session');
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(png);
      }

      if (method === 'POST') {
        const note = await readNote(req);
        if (sub === '/take') {
          controller.takeControl(id);
          opts.onEvent?.('human_took_control', { interventionId: id });
        } else if (sub === '/resume') {
          controller.resume(id, note);
          opts.onEvent?.('human_handed_back', { interventionId: id, note });
        } else if (sub === '/abort') {
          controller.abort(id, note);
          opts.onEvent?.('human_aborted', { interventionId: id, note });
        }
        res.writeHead(303, { location: `/i/${id}` });
        return res.end();
      }

      if (sub === '' && method === 'GET') return send(detailPage(intervention, controller));
      return send(layout('Not found', '<div class="card">Not found.</div>'), 404);
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Console error: ${(err as Error).message}`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 4180, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function readNote(req: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return undefined;
  const note = new URLSearchParams(body).get('note');
  return note && note.trim() ? note.trim() : undefined;
}
