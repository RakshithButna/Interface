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

/** Truncate on a word boundary so a table cell never ends mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}\u2026`;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  /* Frosted-glass control-room look. Self-contained: no CDN, no external
     fonts, no runtime JS -- the console must work with the browser offline and
     must not depend on anything that could fail while an operator is mid-task. */
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    color-scheme: dark light;
    --bg: #0b0f16;
    --glass: rgba(255,255,255,.045);
    --glass-strong: rgba(255,255,255,.075);
    --stroke: rgba(255,255,255,.10);
    --stroke-soft: rgba(255,255,255,.06);
    --fg: #e8ecf3;
    --fg-dim: #9aa5b6;
    --fg-faint: #6b7688;
    --accent: #5b9dff;
    --accent-ink: #ffffff;
    --danger: #ff6b6b;
    --ok: #4ade80;
    --warn: #fbbf24;
    --radius: 16px;
    --radius-sm: 10px;
  }

  @media (prefers-color-scheme: light) {
    :root {
      --bg: #eef1f6;
      --glass: rgba(255,255,255,.62);
      --glass-strong: rgba(255,255,255,.80);
      --stroke: rgba(15,23,42,.10);
      --stroke-soft: rgba(15,23,42,.06);
      --fg: #10151f;
      --fg-dim: #4a5568;
      --fg-faint: #6b7688;
      --accent: #2563eb;
      --danger: #cc2b2b;
      --ok: #15803d;
      --warn: #a16207;
    }
  }

  body {
    margin: 0;
    min-height: 100vh;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--fg);
    background: var(--bg);
    /* Soft aurora wash so the frosted panels have something to blur. */
    background-image:
      radial-gradient(60rem 40rem at 12% -10%, rgba(91,157,255,.20), transparent 60%),
      radial-gradient(50rem 34rem at 92% 6%, rgba(168,85,247,.14), transparent 62%),
      radial-gradient(46rem 34rem at 50% 108%, rgba(34,197,94,.10), transparent 60%);
    background-attachment: fixed;
    -webkit-font-smoothing: antialiased;
  }

  header {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 12px;
    padding: 14px 22px;
    background: var(--glass);
    border-bottom: 1px solid var(--stroke);
    backdrop-filter: blur(18px) saturate(150%);
    -webkit-backdrop-filter: blur(18px) saturate(150%);
  }
  header .mark {
    width: 26px; height: 26px; border-radius: 8px; flex: none;
    background: linear-gradient(140deg, var(--accent), #a855f7);
    box-shadow: 0 0 18px rgba(91,157,255,.45);
  }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
  header .sub { color: var(--fg-faint); font-size: 13px; margin-left: auto; }

  main { max-width: 1000px; margin: 0 auto; padding: 26px 22px 60px; }

  .card {
    background: var(--glass);
    border: 1px solid var(--stroke);
    border-radius: var(--radius);
    padding: 20px 22px;
    margin-bottom: 16px;
    backdrop-filter: blur(22px) saturate(150%);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
    box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 12px 34px rgba(0,0,0,.20);
  }
  .card h2, .card h3 { margin: 0 0 14px; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
  .card h3.section { color: var(--fg-dim); text-transform: uppercase; font-size: 11px; letter-spacing: .09em; }

  .hero { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
  .why { font-size: 19px; font-weight: 600; letter-spacing: -.02em; line-height: 1.4; margin: 0; }

  /* status pill */
  .badge {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 4px 11px 4px 9px; border-radius: 999px;
    font-size: 12px; font-weight: 600; letter-spacing: .01em;
    border: 1px solid var(--stroke); background: var(--glass-strong);
  }
  .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .badge.open    { color: var(--warn); }
  .badge.human   { color: var(--accent); }
  .badge.resumed { color: var(--ok); }
  .badge.aborted { color: var(--danger); }
  .badge.open::before { animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.8); } }

  code, .mono {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12.5px;
    background: var(--glass-strong);
    border: 1px solid var(--stroke-soft);
    padding: 2px 7px; border-radius: 7px;
  }

  dl { display: grid; grid-template-columns: 168px 1fr; gap: 10px 18px; margin: 0; }
  dt { color: var(--fg-faint); font-size: 13px; }
  dd { margin: 0; word-break: break-word; font-size: 14px; }
  @media (max-width: 640px) { dl { grid-template-columns: 1fr; gap: 2px 0; } dt { margin-top: 10px; } }

  .actions { display: flex; gap: 10px; flex-wrap: wrap; }
  button {
    font: inherit; font-size: 14px; font-weight: 550;
    padding: 10px 18px; border-radius: var(--radius-sm);
    border: 1px solid var(--stroke); cursor: pointer;
    background: var(--glass-strong); color: var(--fg);
    transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }
  button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0,0,0,.25); }
  button:active:not(:disabled) { transform: translateY(0); }
  button:disabled { opacity: .40; cursor: not-allowed; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; box-shadow: 0 6px 20px rgba(91,157,255,.32); }
  .danger  { background: transparent; color: var(--danger); border-color: color-mix(in srgb, var(--danger) 42%, transparent); }

  .hint { color: var(--fg-faint); font-size: 13px; line-height: 1.65; margin: 14px 0 0; }
  .muted { color: var(--fg-faint); font-size: 13px; }

  .shot-frame {
    /* The preview is a convenience, not the control channel -- cap it so a
       tall page does not push the action buttons off screen. */
    border-radius: 12px; overflow: auto; max-height: 460px;
    border: 1px solid var(--stroke); background: rgba(0,0,0,.28);
    box-shadow: 0 14px 40px rgba(0,0,0,.32);
  }
  img.shot { display: block; width: 100%; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th {
    text-align: left; padding: 9px 12px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .08em; color: var(--fg-faint);
    border-bottom: 1px solid var(--stroke);
  }
  td { padding: 11px 12px; border-bottom: 1px solid var(--stroke-soft); vertical-align: top; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr { transition: background .12s ease; }
  tbody tr:hover { background: var(--glass-strong); }
  .table-wrap { overflow-x: auto; margin: 0 -6px; }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .back { display: inline-block; margin-bottom: 16px; font-size: 13.5px; color: var(--fg-dim); }

  .empty { text-align: center; padding: 40px 16px; color: var(--fg-faint); }
  .empty .glyph { font-size: 26px; opacity: .5; display: block; margin-bottom: 10px; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
`;

function statusBadge(i: InterventionRequest): string {
  const cls =
    i.status === 'open' ? 'open' : i.status === 'human_in_control' ? 'human' : i.status === 'resumed' ? 'resumed' : 'aborted';
  return `<span class="badge ${cls}">${esc(i.status.replace(/_/g, ' '))}</span>`;
}

function layout(title: string, body: string, refresh = false, heldBy?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} &middot; Operator Console</title>
  ${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
  <style>${STYLE}</style></head>
  <body>
    <header>
      <div class="mark" aria-hidden="true"></div>
      <h1>Operator Console</h1>
      ${heldBy ? `<span class="sub">Control is held by <code>${esc(heldBy)}</code></span>` : ''}
    </header>
    <main>${body}</main>
  </body></html>`;
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
        <td>${esc(i.capability ?? clip(i.goal, 50))}</td>
        <td>${esc(clip(i.reason, 80))}</td>
        <td class="muted">${esc(i.createdAt.slice(11, 19))}</td>
      </tr>`,
    )
    .join('');

  return layout(
    'Interventions',
    `<div class="card">
      <h3 class="section">Queue</h3>
      <div class="hero">
        <span class="badge ${open.length ? 'open' : 'resumed'}">${open.length} open</span>
        <span class="muted">${items.length} total &middot; refreshes automatically</span>
      </div>
    </div>
    <div class="card">
      ${
        items.length === 0
          ? `<div class="empty"><span class="glyph">&#9675;</span>
               No intervention requests yet.<br>
               <span class="muted">Start a run that gets stuck or hits a risky step.</span>
             </div>`
          : `<div class="table-wrap"><table>
               <thead><tr><th>ID</th><th>Status</th><th>Kind</th><th>Capability</th><th>Reason</th><th>At</th></tr></thead>
               <tbody>${rows}</tbody>
             </table></div>`
      }
    </div>`,
    true,
    controller.controlledBy,
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
    : `<div class="actions">
         <form method="POST" action="/i/${esc(i.id)}/take">
           <button ${i.status === 'human_in_control' ? 'disabled' : ''}>Take control</button>
         </form>
         <form method="POST" action="/i/${esc(i.id)}/resume">
           <input type="hidden" name="note" value="">
           <button class="primary">Hand back &amp; resume</button>
         </form>
         <form method="POST" action="/i/${esc(i.id)}/abort">
           <button class="danger">Abort run</button>
         </form>
       </div>
       <p class="hint">
         Take control, then switch to the Chromium window the automation opened and complete the step by hand.
         It is the same live session &mdash; same cookies, same server-side session, same open record.
         Everything you click is recorded below. Hand back when you are done.
       </p>`;

  return layout(
    `Intervention ${i.id}`,
    `<a class="back" href="/">&larr; All interventions</a>
    <div class="card">
      <div class="hero">
        ${statusBadge(i)}
        <code>${esc(i.id)}</code>
      </div>
      <h3 class="section" style="margin-top:16px">Why it stopped</h3>
      <p class="why">${esc(i.reason)}</p>
      ${i.detail ? `<p class="hint">${esc(i.detail)}</p>` : ''}
    </div>
    <div class="card">
      <h3 class="section">Context</h3>
      <dl>
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
      <h3 class="section">Live session</h3>
      <div class="shot-frame">
        <img class="shot" src="/i/${esc(i.id)}/shot.png?t=${Date.now()}" alt="Current screen of the paused browser session">
      </div>
    </div>
    <div class="card">
      <h3 class="section">Human actions recorded (${i.humanActions.length})</h3>
      ${
        i.humanActions.length === 0
          ? `<div class="empty"><span class="glyph">&#9711;</span>
               Nothing yet.<br>
               <span class="muted">Actions you take in the live browser window appear here.</span>
             </div>`
          : `<div class="table-wrap"><table>
               <thead><tr><th>Time</th><th>Type</th><th>Frame</th><th>Control</th><th>Value</th></tr></thead>
               <tbody>${actions}</tbody>
             </table></div>`
      }
    </div>`,
    !i.resolution,
    controller.controlledBy,
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
      if (!m) return send(layout('Not found', '<div class="card"><div class="empty"><span class="glyph">&#9888;</span>Not found.</div></div>'), 404);

      const id = m[1]!;
      const sub = m[2] ?? '';
      const intervention = controller.get(id);
      if (!intervention) return send(layout('Not found', '<div class="card"><div class="empty"><span class="glyph">&#9888;</span>No such intervention.</div></div>'), 404);

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
      return send(layout('Not found', '<div class="card"><div class="empty"><span class="glyph">&#9888;</span>Not found.</div></div>'), 404);
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Console error: ${(err as Error).message}`);
      }
    });
  });

  /**
   * Bind without letting a busy port kill the run.
   *
   * `server.listen()` reports failure by emitting an `error` event, and an
   * unhandled `error` event on an EventEmitter is a hard process crash. So a
   * second console on the same port -- an earlier run still shutting down, or
   * anything else on 4180 -- took down the entire replay with a raw Node stack
   * trace, losing the browser session along with it.
   *
   * The console is an accessory to the run, never a reason to end it, so a
   * busy port falls back to an ephemeral one. The actual URL is returned and
   * printed either way, so the operator always has a working link.
   */
  const requested = opts.port ?? 4180;
  const bind = (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  try {
    await bind(requested);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    console.warn(
      `  [operator console] port ${requested} is already in use; using a free port instead.`,
    );
    await bind(0);
  }

  // A later failure (a client resetting the connection, for instance) must not
  // crash the process either.
  server.on('error', (err) => {
    console.warn(`  [operator console] ${(err as Error).message}`);
  });

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
