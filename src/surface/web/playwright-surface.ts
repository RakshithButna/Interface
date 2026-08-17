/**
 * The web implementation of `Surface`, backed by Playwright.
 *
 * Everything Playwright-specific in this system lives in this file. Nothing
 * above it imports Playwright, which is what makes the desktop story in
 * REPORT.md section 4 credible rather than aspirational.
 *
 * Two implementation choices worth explaining:
 *
 * - Refs are element HANDLES, not selectors. `observe()` stashes the actual
 *   DOM elements it described on `window.__cuaNodes`, and `perform()` reaches
 *   back for the same element via `evaluateHandle`. Re-querying by selector
 *   between observing and acting is how automation ends up clicking a
 *   different element than the one it reasoned about -- especially in a grid
 *   where several elements match equally well. If the page navigated in
 *   between, the handle is gone and we fail loudly instead of guessing.
 *
 * - HTTP status is tracked for every frame navigation, not just the main
 *   frame. This app -- like a lot of legacy software -- signals permission
 *   denial with a 403 whose body is an ordinary-looking page rendered inside a
 *   subframe. Watching only the top document would miss it entirely.
 *
 * The browser is launched headed by default, because "a human takes control of
 * the live session" (brief section 3.6) has to mean an actual window a person
 * can actually use.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Frame, type ElementHandle } from 'playwright';
import type { FrameRef } from '../../schema/targeting.ts';
import type {
  Surface,
  SurfaceOp,
  Observation,
  UiNode,
  FrameObservation,
  NameSource,
  SurfaceCapabilities,
} from '../types.ts';
import { extractFrame, type RawFrameResult } from './extract.ts';

/**
 * How long to wait for a click to produce a navigation before concluding it
 * was not a navigating click. Short enough not to tax ordinary clicks, long
 * enough to cover a local form POST.
 */
const NAVIGATION_GRACE_MS = 1_500;

export class SurfaceError extends Error {
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'SurfaceError';
    this.detail = detail;
  }
}

export interface WebSurfaceOptions {
  headless?: boolean;
  /** Slows actions down so a human watching a handoff can follow along. */
  slowMoMs?: number;
  viewport?: { width: number; height: number };
  maxNodesPerFrame?: number;
  defaultTimeoutMs?: number;
}

export class PlaywrightWebSurface implements Surface {
  readonly id: string;
  readonly kind = 'web' as const;
  readonly capabilities: SurfaceCapabilities;

  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;

  /** Frames as enumerated by the most recent observe(), in ref order. */
  private frameIndex: Frame[] = [];
  private statusByFrameUrl = new Map<string, number>();
  private lastNavStatus: number | undefined;
  private readonly opts: Required<WebSurfaceOptions>;

  private constructor(id: string, opts: Required<WebSurfaceOptions>) {
    this.id = id;
    this.opts = opts;
    this.capabilities = {
      screenshots: true,
      domSnapshots: true,
      humanTakeover: !opts.headless,
    };
  }

  static async launch(id: string, options: WebSurfaceOptions = {}): Promise<PlaywrightWebSurface> {
    const opts: Required<WebSurfaceOptions> = {
      headless: options.headless ?? false,
      slowMoMs: options.slowMoMs ?? 0,
      viewport: options.viewport ?? { width: 1280, height: 900 },
      maxNodesPerFrame: options.maxNodesPerFrame ?? 250,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 15_000,
    };

    const s = new PlaywrightWebSurface(id, opts);
    s.browser = await chromium.launch({ headless: opts.headless, slowMo: opts.slowMoMs });
    s.context = await s.browser.newContext({ viewport: opts.viewport });
    s.context.setDefaultTimeout(opts.defaultTimeoutMs);
    s.page = await s.context.newPage();

    s.page.on('response', (res) => {
      const req = res.request();
      if (req.resourceType() === 'document') {
        s.statusByFrameUrl.set(res.url(), res.status());
        s.lastNavStatus = res.status();
      }
    });

    return s;
  }

  /** Escape hatch for the escalation layer, which needs the live page. */
  livePage(): Page {
    return this.page;
  }

  currentUrl(): string {
    return this.page.url();
  }

  lastHttpStatus(): number | undefined {
    return this.lastNavStatus;
  }

  /* ------------------------------------------------------------- observe */

  private framePathOf(frame: Frame): FrameRef[] {
    const path: FrameRef[] = [];
    let cur: Frame | null = frame;
    while (cur && cur.parentFrame()) {
      const name = cur.name();
      // Frame name is preferred: legacy apps target their own frames by name
      // (target="mainFrame"), so the name is load-bearing for the app itself
      // and therefore stable. Index is a last resort.
      path.unshift(name ? { by: 'name', name } : { by: 'urlPattern', pattern: stripQuery(cur.url()) });
      cur = cur.parentFrame();
    }
    return path;
  }

  async observe(): Promise<Observation> {
    // Best-effort settle. A slow frame should degrade the observation, not
    // abort it -- the agent may still be able to act on what has loaded.
    await this.settle(3_000).catch(() => undefined);

    const frames = this.page.frames();
    this.frameIndex = frames;

    const frameObs: FrameObservation[] = [];
    const nodes: UiNode[] = [];
    let truncated = false;

    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi]!;
      if (frame.isDetached()) continue;

      let raw: RawFrameResult;
      try {
        raw = await frame.evaluate(extractFrame, this.opts.maxNodesPerFrame);
      } catch {
        // Frames navigate out from under us constantly in frameset apps.
        // A frame we cannot read is not a failure of the observation.
        continue;
      }

      const path = this.framePathOf(frame);
      frameObs.push({ index: fi, path, url: raw.url, text: raw.text });
      if (raw.truncated) truncated = true;

      for (const r of raw.nodes) {
        const node: UiNode = {
          ref: `${fi}#${r.index}`,
          role: r.role,
          name: r.name,
          nameSource: r.nameSource as NameSource,
          interactive: r.interactive,
          framePath: path,
          frameIndex: fi,
          tag: r.tag,
          css: r.css,
        };
        if (r.value !== undefined) node.value = r.value;
        if (r.text !== undefined) node.text = r.text;
        if (r.disabled !== undefined) node.disabled = r.disabled;
        if (r.checked !== undefined) node.checked = r.checked;
        if (r.formFieldName !== undefined) node.formFieldName = r.formFieldName;
        if (r.formName !== undefined) node.formName = r.formName;
        if (r.testId !== undefined) node.testId = r.testId;
        if (r.href !== undefined) node.href = r.href;
        if (r.inputType !== undefined) node.inputType = r.inputType;
        if (r.options !== undefined) node.options = r.options;
        if (r.table !== undefined) node.table = r.table;
        nodes.push(node);
      }
    }

    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      httpStatus: this.resolveStatus(frameObs),
      frames: frameObs,
      nodes,
      capturedAt: new Date().toISOString(),
      truncated,
    };
  }

  /**
   * Pick the status most likely to describe what the operator is looking at:
   * the status recorded for a subframe document if we have one, otherwise the
   * most recent navigation status.
   */
  private resolveStatus(frames: FrameObservation[]): number | undefined {
    for (let i = frames.length - 1; i >= 0; i--) {
      const s = this.statusByFrameUrl.get(frames[i]!.url);
      if (s !== undefined && s >= 400) return s;
    }
    const main = this.statusByFrameUrl.get(this.page.url());
    return main ?? this.lastNavStatus;
  }

  /* ------------------------------------------------------------- perform */

  private async handleFor(ref: string): Promise<ElementHandle<Element>> {
    const [fiRaw, niRaw] = ref.split('#');
    const fi = Number(fiRaw);
    const ni = Number(niRaw);
    const frame = this.frameIndex[fi];
    if (!frame || frame.isDetached()) {
      throw new SurfaceError(`Frame ${fi} is no longer available`, `ref=${ref}`);
    }
    const handle = await frame.evaluateHandle(
      (i: number) => (window as unknown as { __cuaNodes?: Element[] }).__cuaNodes?.[i] ?? null,
      ni,
    );
    const el = handle.asElement();
    if (!el) {
      throw new SurfaceError(
        'Element handle expired; the page changed between observing and acting',
        `ref=${ref}`,
      );
    }
    return el as ElementHandle<Element>;
  }

  async perform(op: SurfaceOp): Promise<void> {
    switch (op.kind) {
      case 'navigate': {
        const res = await this.page.goto(op.url, { waitUntil: 'domcontentloaded' });
        if (res) this.lastNavStatus = res.status();
        return;
      }
      case 'click': {
        const el = await this.handleFor(op.ref);
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        await this.clickAwaitingNavigation(el);
        return;
      }
      case 'fill': {
        const el = await this.handleFor(op.ref);
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        if (op.clearFirst) await el.fill('');
        await el.fill(op.value);
        return;
      }
      case 'select': {
        const el = await this.handleFor(op.ref);
        // Try by value first, then by visible label. Legacy <select> options
        // frequently have codes as values and human words as labels, and the
        // recorded value could reasonably be either.
        const byValue = await el.selectOption({ value: op.value }).catch(() => [] as string[]);
        if (byValue.length === 0) {
          const byLabel = await el.selectOption({ label: op.value }).catch(() => [] as string[]);
          if (byLabel.length === 0) {
            throw new SurfaceError(`No option matching '${op.value}'`);
          }
        }
        return;
      }
      case 'press': {
        if (op.ref) {
          const el = await this.handleFor(op.ref);
          await el.press(op.key);
        } else {
          await this.page.keyboard.press(op.key);
        }
        return;
      }
      case 'back': {
        await this.page.goBack({ waitUntil: 'domcontentloaded' });
        return;
      }
    }
  }

  /**
   * Click, then wait for a navigation the click may have caused.
   *
   * `elementHandle.click()` resolves as soon as the event is dispatched, which
   * can be before the resulting request has even started. In a frameset app
   * that is a real problem: the submit navigates a SUBFRAME, so the page-level
   * load state is already settled and `networkidle` returns instantly against
   * an empty network. The next observation then reads the previous document
   * and the automation reasons about a screen that no longer exists.
   *
   * So we arm a `framenavigated` listener before clicking and give it a short
   * grace period afterwards. A click that navigates is awaited properly; a
   * click that does not costs one short timeout.
   */
  private async clickAwaitingNavigation(el: ElementHandle<Element>): Promise<void> {
    const navigated = this.page
      .waitForEvent('framenavigated', { timeout: NAVIGATION_GRACE_MS })
      .then(() => true)
      .catch(() => false);

    await el.click({ timeout: this.opts.defaultTimeoutMs });

    if (await navigated) {
      await this.settle(this.opts.defaultTimeoutMs);
    }
  }

  async read(
    ref: string,
    from: 'text' | 'value' | 'href' | 'attribute',
    attribute?: string,
  ): Promise<string | null> {
    const el = await this.handleFor(ref);
    switch (from) {
      case 'text':
        return (await el.textContent())?.replace(/\s+/g, ' ').trim() ?? null;
      case 'value':
        return await el.evaluate((e) => (e as HTMLInputElement).value ?? null);
      case 'href':
        return await el.getAttribute('href');
      case 'attribute':
        return attribute ? await el.getAttribute(attribute) : null;
    }
  }

  /* ----------------------------------------------------------- evidence */

  async screenshot(): Promise<Buffer | null> {
    try {
      return await this.page.screenshot({ fullPage: true });
    } catch {
      return null;
    }
  }

  async domSnapshot(): Promise<string | null> {
    try {
      const parts: string[] = [];
      for (const frame of this.page.frames()) {
        if (frame.isDetached()) continue;
        const html = await frame.content().catch(() => null);
        if (html === null) continue;
        parts.push(`<!-- frame: ${frame.name() || '(top)'} url=${frame.url()} -->\n${html}`);
      }
      return parts.join('\n\n');
    } catch {
      return null;
    }
  }

  /**
   * Settle the page AND every subframe. Page-level load state says nothing
   * about a frameset's children, which is where all the content lives here.
   */
  async settle(timeoutMs: number): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
    await Promise.all(
      this.page.frames().map((f) =>
        f.isDetached() ? Promise.resolve() : f.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined),
      ),
    );
    await this.page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}
