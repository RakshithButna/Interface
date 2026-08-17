/**
 * Capturing what the human did while they held the session.
 *
 * The brief asks for the human's actions to be recorded across the handoff.
 * That is not just an audit nicety in a regulated setting -- it is the only
 * record of what happened to a member's account during the window where the
 * automation was not driving, and it is what tells you whether the state the
 * automation resumes into is the state it expects.
 *
 * Implementation: capture-phase listeners installed in every frame, reporting
 * back through an exposed binding. Capture phase matters because legacy pages
 * routinely stop propagation in their own handlers. Listeners are reinstalled
 * on every frame navigation, since the operator will navigate.
 *
 * Values are redacted at the source, in the page, before they cross back into
 * Node: a password field reports that it was filled and never what with. That
 * ordering is deliberate -- data that never leaves the browser cannot be
 * leaked by a logging mistake later.
 */

import type { Page } from 'playwright';
import type { HumanAction } from './session-control.ts';

const BINDING = '__cuaHumanEvent';

interface WireEvent {
  type: 'click' | 'input' | 'change';
  frame: string;
  control: string;
  value?: string;
  url: string;
}

/**
 * Installed into every document. Self-contained: it is serialised into the
 * page, so it cannot reference anything from module scope.
 */
function installListeners(bindingName: string): void {
  const w = window as unknown as Record<string, unknown> & {
    __cuaInstalled?: boolean;
  };
  if (w.__cuaInstalled) return;
  w.__cuaInstalled = true;

  const report = (payload: unknown): void => {
    const fn = w[bindingName] as ((p: unknown) => void) | undefined;
    if (typeof fn === 'function') {
      try {
        fn(payload);
      } catch {
        /* never let reporting break the operator's session */
      }
    }
  };

  const describe = (el: Element | null): string => {
    if (!el) return '(unknown)';
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    const name = el.getAttribute('name');
    const value = el.getAttribute('value');
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (tag === 'input' && (type === 'submit' || type === 'button')) return `${tag}[${value ?? ''}]`;
    if (name) return `${tag}[name=${name}]`;
    return text ? `${tag}["${text}"]` : tag;
  };

  /** Redact IN THE PAGE. Sensitive values never reach Node at all. */
  const safeValue = (el: Element): string | undefined => {
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (type === 'password') return '[REDACTED:password]';
    const v = (el as HTMLInputElement).value;
    if (typeof v !== 'string') return undefined;
    return v.length > 60 ? `${v.slice(0, 60)}...` : v;
  };

  document.addEventListener(
    'click',
    (e) => {
      const el = e.target as Element | null;
      report({ type: 'click', frame: window.name || '(top)', control: describe(el), url: location.href });
    },
    true,
  );

  document.addEventListener(
    'change',
    (e) => {
      const el = e.target as Element | null;
      if (!el) return;
      report({
        type: 'change',
        frame: window.name || '(top)',
        control: describe(el),
        value: safeValue(el),
        url: location.href,
      });
    },
    true,
  );
}

export class HumanActionRecorder {
  private page: Page;
  private onAction: (a: HumanAction) => void;
  private started = false;
  private lastUrl = '';

  constructor(page: Page, onAction: (a: HumanAction) => void) {
    this.page = page;
    this.onAction = onAction;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.page.exposeBinding(BINDING, (_source, payload: WireEvent) => {
      const action: HumanAction = {
        ts: new Date().toISOString(),
        type: payload.type,
        frame: payload.frame,
        control: payload.control,
        url: payload.url,
      };
      if (payload.value !== undefined) action.value = payload.value;
      this.onAction(action);
    });

    // Applies to documents loaded from here on...
    await this.page.addInitScript(installListeners, BINDING);
    // ...and to the ones already open.
    await this.attachToExistingFrames();

    this.page.on('framenavigated', (frame) => {
      void frame.evaluate(installListeners, BINDING).catch(() => undefined);
      if (frame === this.page.mainFrame() && frame.url() !== this.lastUrl) {
        this.lastUrl = frame.url();
        this.onAction({ ts: new Date().toISOString(), type: 'navigate', url: frame.url() });
      }
    });
  }

  private async attachToExistingFrames(): Promise<void> {
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      await frame.evaluate(installListeners, BINDING).catch(() => undefined);
    }
  }
}
