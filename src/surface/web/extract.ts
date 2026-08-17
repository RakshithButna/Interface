/**
 * The in-page extraction routine.
 *
 * This function is serialised and executed inside the browser, once per frame,
 * so it must be entirely self-contained -- no imports, no closure over module
 * scope. Everything it needs is defined inside it.
 *
 * Its job is to turn a document into accessibility-tree-shaped nodes. Two
 * parts of that are doing real work rather than restating the DOM:
 *
 * 1. Accessible-name computation with a LEGACY FALLBACK. The standard
 *    algorithm (aria-label, aria-labelledby, label[for], wrapping label) leaves
 *    most inputs in a table-layout enterprise app with no name at all, because
 *    the visible label is just text in the previous <td>. We compute that
 *    fallback and tag it `adjacentCell` so downstream code knows the name was
 *    inferred from geometry rather than read from a real association. Without
 *    this, roughly every form field in the target app would be anonymous.
 *
 * 2. Table geometry. For each node we record its row's cell values and the
 *    table's column headers. That is the raw material for row-anchored
 *    targeting, which is the only way to distinguish the "View" link on the row
 *    for member 12345 from the identical "View" link one row down.
 *
 * Elements are also stashed on `window.__cuaNodes` so the surface can hand the
 * same element back to Playwright for a real click, rather than re-querying and
 * risking a different match.
 */

export interface RawNode {
  index: number;
  role: string;
  name: string;
  nameSource: string;
  value?: string;
  text?: string;
  tag: string;
  inputType?: string;
  formFieldName?: string;
  formName?: string;
  testId?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  interactive: boolean;
  options?: Array<{ value: string; label: string }>;
  css: string;
  table?: {
    headers: string[];
    rowCells: string[];
    rowIndex: number;
    colIndex: number;
    columnHeader?: string;
  };
}

export interface RawFrameResult {
  url: string;
  title: string;
  text: string;
  nodes: RawNode[];
  truncated: boolean;
}

/** Executed in the browser. Keep self-contained. */
export function extractFrame(maxNodes: number): RawFrameResult {
  const doc = document;
  const store: Element[] = [];
  (window as unknown as { __cuaNodes: Element[] }).__cuaNodes = store;

  const txt = (el: Element | null | undefined): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const attr = (el: Element, n: string): string | undefined => {
    const v = el.getAttribute(n);
    return v === null ? undefined : v;
  };

  const roleOf = (el: Element): string => {
    const explicit = attr(el, 'role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (attr(el, 'type') ?? 'text').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'hidden') return 'hidden';
      return 'textbox';
    }
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'tr') return 'row';
    if (tag === 'table') return 'table';
    if (tag === 'form') return 'form';
    if (tag === 'iframe' || tag === 'frame') return 'frame';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return 'generic';
  };

  /**
   * Accessible name. Order follows the ARIA spec until it runs out, then falls
   * back to the legacy adjacent-cell heuristic described in the file header.
   */
  const accName = (el: Element): [string, string] => {
    const aria = attr(el, 'aria-label');
    if (aria && aria.trim()) return [aria.trim(), 'ariaLabel'];

    const labelledBy = attr(el, 'aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => txt(doc.getElementById(id)))
        .filter(Boolean);
      if (parts.length) return [parts.join(' '), 'ariaLabelledBy'];
    }

    const tag = el.tagName.toLowerCase();
    const type = (attr(el, 'type') ?? '').toLowerCase();

    // <input type=submit value="Search"> -- the accessible name IS the value.
    if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
      const v = attr(el, 'value');
      if (v && v.trim()) return [v.trim(), 'value'];
    }

    if (tag === 'button' || tag === 'a' || tag === 'th' || tag === 'option' || /^h[1-6]$/.test(tag)) {
      const t = txt(el);
      if (t) return [t, 'textContent'];
    }

    if (el.id) {
      const escaped = el.id.replace(/["\\]/g, '\\$&');
      const lbl = doc.querySelector(`label[for="${escaped}"]`);
      if (lbl) {
        const t = txt(lbl);
        if (t) return [t.replace(/[:*]\s*$/, ''), 'labelFor'];
      }
    }

    const wrapping = el.closest('label');
    if (wrapping) {
      const t = txt(wrapping);
      if (t) return [t.replace(/[:*]\s*$/, ''), 'labelWrapping'];
    }

    // Legacy fallback: the label is plain text in a preceding cell of the same
    // row. No association exists in the markup; only geometry connects them.
    const ownCell = el.closest('td, th');
    if (ownCell) {
      let prev = ownCell.previousElementSibling;
      while (prev) {
        const t = txt(prev);
        if (t) return [t.replace(/[:*]\s*$/, ''), 'adjacentCell'];
        prev = prev.previousElementSibling;
      }
    }

    const title = attr(el, 'title');
    if (title && title.trim()) return [title.trim(), 'title'];
    const ph = attr(el, 'placeholder');
    if (ph && ph.trim()) return [ph.trim(), 'placeholder'];

    if (tag === 'td') {
      const t = txt(el);
      if (t) return [t, 'textContent'];
    }
    return ['', 'none'];
  };

  const tableCtx = (el: Element): RawNode['table'] => {
    const cell = (el.tagName === 'TD' || el.tagName === 'TH' ? el : el.closest('td, th')) as
      | HTMLTableCellElement
      | null;
    if (!cell) return undefined;
    const row = cell.closest('tr') as HTMLTableRowElement | null;
    if (!row) return undefined;
    const table = row.closest('table') as HTMLTableElement | null;
    if (!table) return undefined;

    const rows = Array.from(table.rows);
    const rowIndex = rows.indexOf(row);
    const cells = Array.from(row.cells);
    const colIndex = cells.indexOf(cell);

    // Header row: the first row containing a <th>, else the first row.
    let headerRow: HTMLTableRowElement | undefined = rows.find((r) => r.querySelector('th') !== null);
    if (!headerRow) headerRow = rows[0];
    const headers = headerRow ? Array.from(headerRow.cells).map((c) => txt(c)) : [];

    const ctx: RawNode['table'] = {
      headers,
      rowCells: cells.map((c) => txt(c)),
      rowIndex,
      colIndex,
    };
    const h = headers[colIndex];
    if (h) ctx.columnHeader = h;
    return ctx;
  };

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`${sel}#${cur.id}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = parent;
    }
    return parts.join(' > ');
  };

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const INTERACTIVE = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]';

  const candidates: Element[] = [];
  const seen = new Set<Element>();
  const push = (el: Element) => {
    if (!seen.has(el)) {
      seen.add(el);
      candidates.push(el);
    }
  };

  doc.querySelectorAll(INTERACTIVE).forEach(push);
  doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(push);
  // Cells carry the readable values in a legacy grid, so they are nodes too.
  doc.querySelectorAll('td, th').forEach((c) => {
    if (txt(c)) push(c);
  });

  const nodes: RawNode[] = [];
  let truncated = false;

  for (const el of candidates) {
    if (nodes.length >= maxNodes) {
      truncated = true;
      break;
    }
    const tag = el.tagName.toLowerCase();
    const inputType = (attr(el, 'type') ?? '').toLowerCase();
    if (tag === 'input' && inputType === 'hidden') continue;
    if (!isVisible(el)) continue;

    const [name, nameSource] = accName(el);
    const role = roleOf(el);
    const interactive =
      role === 'link' ||
      role === 'button' ||
      role === 'textbox' ||
      role === 'combobox' ||
      role === 'listbox' ||
      role === 'checkbox' ||
      role === 'radio';

    const index = store.length;
    store.push(el);

    const node: RawNode = {
      index,
      role,
      name,
      nameSource,
      tag,
      interactive,
      css: cssPath(el),
    };

    if (inputType) node.inputType = inputType;

    const fieldName = attr(el, 'name');
    if (fieldName) node.formFieldName = fieldName;

    const form = (el as HTMLInputElement).form;
    if (form) {
      const fn = attr(form, 'name') ?? attr(form, 'id');
      if (fn) node.formName = fn;
    }

    const testId = attr(el, 'data-testid') ?? attr(el, 'data-test-id') ?? attr(el, 'data-qa');
    if (testId) node.testId = testId;

    if (tag === 'a') {
      const href = attr(el, 'href');
      if (href) node.href = (el as HTMLAnchorElement).href;
    }

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const v = (el as HTMLInputElement).value;
      if (v) node.value = v;
      if ((el as HTMLInputElement).disabled) node.disabled = true;
      if (inputType === 'checkbox' || inputType === 'radio') {
        node.checked = (el as HTMLInputElement).checked;
      }
    }

    if (tag === 'select') {
      node.options = Array.from((el as HTMLSelectElement).options).map((o) => ({
        value: o.value,
        label: txt(o),
      }));
    }

    const own = txt(el);
    if (own && own.length <= 200) node.text = own;

    const tc = tableCtx(el);
    if (tc) node.table = tc;

    nodes.push(node);
  }

  return {
    url: location.href,
    title: doc.title,
    text: (doc.body?.innerText ?? doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 8000),
    nodes,
    truncated,
  };
}
