// Single-column TUI for `capy edit`: variables list with an inline popup
// detail view. Built on raw stdin + ANSI codes so we don't add a TUI dependency.

import { formatSnippet } from '../commands/statusCommand';

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const MOVE_HOME = `${ESC}[H`;
const CLEAR_SCREEN = `${ESC}[2J`;
const CLEAR_EOL = `${ESC}[K`;
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
const EXIT_ALT_SCREEN = `${ESC}[?1049l`;
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const CYAN = `${ESC}[36m`;

const MARGIN = 2;
const NO_VALUE = '—';

export interface EditRow {
  key: string;
  localValue: string | undefined;
  remoteValue: string | undefined;
  status: 'in sync' | 'local' | 'remote' | 'conflict' | 'unknown';
  updatedLabel: string;
}

export interface EditState {
  projectName: string;
  branch: string;
  rows: EditRow[];
  remoteAvailable: boolean;
}

export interface EditContext {
  saveLocalEdits: (edits: Record<string, string>) => Promise<void>;
}

export class EditScreen {
  private state: EditState = { projectName: '', branch: '', rows: [], remoteAvailable: false };
  private ctx: EditContext | null = null;
  private cursorIndex = 0;
  private revealed = new Set<string>();
  private editing: { key: string; buffer: string } | null = null;
  private statusMessage: { text: string; isError: boolean } | null = null;
  private scrollOffset = 0;
  private onDataHandler: ((data: Buffer) => void) | null = null;
  private onResizeHandler: (() => void) | null = null;
  private cleanedUp = false;
  private pendingEdits: Map<string, string> = new Map();
  private quitPrompt: 'commit' | null = null;
  private popupOpen = false;
  private popupPanOffset = 0;

  run(state: EditState, ctx: EditContext): Promise<void> {
    this.state = state;
    this.ctx = ctx;
    this.cursorIndex = 0;
    this.revealed.clear();
    this.editing = null;
    this.statusMessage = null;
    this.scrollOffset = 0;
    this.cleanedUp = false;
    this.pendingEdits.clear();
    this.quitPrompt = null;
    this.popupOpen = false;
    this.popupPanOffset = 0;

    return new Promise<void>((resolve) => {
      process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();

      this.draw();

      this.onDataHandler = (data: Buffer) => this.handleKeypress(data, resolve);
      process.stdin.on('data', this.onDataHandler);

      this.onResizeHandler = () => this.draw();
      process.on('SIGWINCH', this.onResizeHandler);

      const exit = () => {
        this.cleanup();
        resolve();
      };
      process.on('SIGINT', exit);
      process.on('SIGTERM', exit);
    });
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (this.onDataHandler) process.stdin.removeListener('data', this.onDataHandler);
    if (this.onResizeHandler) process.removeListener('SIGWINCH', this.onResizeHandler);
  }

  private handleKeypress(data: Buffer, resolve: () => void): void {
    const key = data.toString();

    // Ctrl-C exits unconditionally
    if (key === '\x03') {
      this.cleanup();
      resolve();
      return;
    }

    if (this.quitPrompt) {
      this.handleQuitPromptKey(key, resolve);
      return;
    }

    if (this.editing) {
      this.handleEditKey(key);
      return;
    }

    if (key === 'q' || key === 'Q') {
      if (this.pendingEdits.size > 0) {
        this.quitPrompt = 'commit';
        this.draw();
      } else {
        this.cleanup();
        resolve();
      }
      return;
    }

    // Esc closes the popup (when open)
    if ((key === ESC || key === `${ESC}\x1b`) && this.popupOpen) {
      this.popupOpen = false;
      this.popupPanOffset = 0;
      this.draw();
      return;
    }

    // Arrow up
    if (key === `${ESC}[A`) {
      if (this.cursorIndex > 0) {
        this.cursorIndex--;
        this.popupPanOffset = 0;
        this.draw();
      }
      return;
    }

    // Arrow down
    if (key === `${ESC}[B`) {
      if (this.cursorIndex < this.state.rows.length - 1) {
        this.cursorIndex++;
        this.popupPanOffset = 0;
        this.draw();
      }
      return;
    }

    // Arrow left — pan value left when popup open + revealed
    if (key === `${ESC}[D`) {
      if (this.popupOpen && this.popupPanOffset > 0) {
        this.popupPanOffset = Math.max(0, this.popupPanOffset - 8);
        this.draw();
      }
      return;
    }

    // Arrow right — pan value right when popup open + revealed
    if (key === `${ESC}[C`) {
      if (this.popupOpen) {
        this.popupPanOffset += 8;
        this.draw();
      }
      return;
    }

    // Home / End — pan to start / end (when popup open + revealed)
    if (key === `${ESC}[H` || key === `${ESC}[1~`) {
      if (this.popupOpen) {
        this.popupPanOffset = 0;
        this.draw();
      }
      return;
    }
    if (key === `${ESC}[F` || key === `${ESC}[4~`) {
      if (this.popupOpen) {
        this.popupPanOffset = Number.MAX_SAFE_INTEGER;
        this.draw();
      }
      return;
    }

    // Enter / Space — toggle popup
    if (key === '\r' || key === '\n' || key === ' ') {
      this.popupOpen = !this.popupOpen;
      this.popupPanOffset = 0;
      this.draw();
      return;
    }

    if (key === 'r' || key === 'R') {
      const row = this.state.rows[this.cursorIndex];
      if (!row) return;
      if (this.revealed.has(row.key)) this.revealed.delete(row.key);
      else this.revealed.add(row.key);
      this.popupOpen = true;
      this.popupPanOffset = 0;
      this.draw();
      return;
    }

    if (key === 'e' || key === 'E') {
      const row = this.state.rows[this.cursorIndex];
      if (!row) return;
      this.editing = { key: row.key, buffer: row.localValue ?? '' };
      this.statusMessage = null;
      this.popupOpen = true;
      this.popupPanOffset = 0;
      this.draw();
      return;
    }

    if (key === 'c' || key === 'C') {
      if (this.pendingEdits.size > 0) {
        void this.commitInPlace();
      }
      return;
    }
  }

  private async commitInPlace(): Promise<void> {
    if (!this.ctx || this.pendingEdits.size === 0) return;
    const editedKeys = Array.from(this.pendingEdits.keys());
    const edits = Object.fromEntries(this.pendingEdits);
    this.statusMessage = { text: `Committing & pushing ${editedKeys.length} change(s)…`, isError: false };
    this.draw();
    try {
      await this.ctx.saveLocalEdits(edits);
      this.pendingEdits.clear();
      // After push, remote == local for the edited rows.
      for (const k of editedKeys) {
        const row = this.state.rows.find((r) => r.key === k);
        if (row && row.localValue !== undefined) {
          row.remoteValue = row.localValue;
          row.status = this.reclassify(row);
          row.updatedLabel = row.status === 'in sync' ? 'in sync' : row.status;
        }
      }
      this.statusMessage = { text: `Committed ${editedKeys.length} change(s)`, isError: false };
    } catch (err: any) {
      this.statusMessage = { text: `Error committing: ${err?.message || err}`, isError: true };
    }
    this.draw();
  }

  private handleEditKey(key: string): void {
    if (!this.editing) return;

    // Esc — both bare ESC and ESC ESC (some terminals double-emit)
    if (key === ESC || key === `${ESC}\x1b`) {
      this.editing = null;
      this.draw();
      return;
    }

    // Enter
    if (key === '\r' || key === '\n') {
      void this.commitEdit();
      return;
    }

    // Backspace / Delete
    if (key === '\x7f' || key === '\b') {
      this.editing.buffer = this.editing.buffer.slice(0, -1);
      this.draw();
      return;
    }

    // Ignore other control sequences (arrow keys etc)
    if (key.startsWith(ESC)) return;

    // Append printable characters (treat the buffer as a stream — works for
    // multi-byte paste too since paste arrives as one chunk)
    let appended = '';
    for (const ch of key) {
      const code = ch.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f) appended += ch;
    }
    if (appended) {
      this.editing.buffer += appended;
      this.draw();
    }
  }

  private async commitEdit(): Promise<void> {
    if (!this.editing || !this.ctx) return;
    const { key, buffer } = this.editing;
    this.editing = null;

    // Buffer the edit in memory; it gets written on quit-confirm.
    this.pendingEdits.set(key, buffer);
    const row = this.state.rows.find((r) => r.key === key);
    if (row) {
      row.localValue = buffer;
      row.status = this.reclassify(row);
      row.updatedLabel = row.status === 'in sync' ? 'in sync' : row.status;
    }
    this.statusMessage = { text: `Edited ${key} (uncommitted)`, isError: false };
    this.draw();
  }

  private handleQuitPromptKey(key: string, resolve: () => void): void {
    // 'c' commit & push, 'd' discard & quit, 'k'/Esc keep working
    if (key === 'c' || key === 'C') {
      void this.commitAndQuit(resolve);
      return;
    }
    if (key === 'd' || key === 'D') {
      this.pendingEdits.clear();
      this.cleanup();
      resolve();
      return;
    }
    if (key === 'k' || key === 'K' || key === ESC || key === '\x1b\x1b') {
      this.quitPrompt = null;
      this.draw();
      return;
    }
  }

  private async commitAndQuit(resolve: () => void): Promise<void> {
    if (!this.ctx) return;
    const edits = Object.fromEntries(this.pendingEdits);
    this.statusMessage = { text: `Committing & pushing ${this.pendingEdits.size} change(s)…`, isError: false };
    this.draw();
    try {
      await this.ctx.saveLocalEdits(edits);
      this.pendingEdits.clear();
      this.cleanup();
      resolve();
    } catch (err: any) {
      this.quitPrompt = null;
      this.statusMessage = { text: `Error committing: ${err?.message || err}`, isError: true };
      this.draw();
    }
  }

  // Local-only reclassification. We don't refetch remote, so the remote side
  // is treated as unchanged from when the TUI loaded.
  private reclassify(row: EditRow): EditRow['status'] {
    if (!this.state.remoteAvailable) return 'unknown';
    const localPresent = row.localValue !== undefined;
    const remotePresent = row.remoteValue !== undefined;
    if (localPresent && remotePresent && row.localValue === row.remoteValue) {
      return 'in sync';
    }
    if (!localPresent && remotePresent) return 'remote';
    if (localPresent && !remotePresent) return 'local';
    if (row.localValue !== row.remoteValue) return 'conflict';
    return 'in sync';
  }

  private draw(): void {
    const termWidth = process.stdout.columns || 80;
    const termHeight = process.stdout.rows || 24;
    const output = this.render(termWidth, termHeight);
    process.stdout.write(CLEAR_SCREEN + MOVE_HOME + output);
  }

  private render(termWidth: number, termHeight: number): string {
    const m = ' '.repeat(MARGIN);
    const available = Math.max(40, termWidth - MARGIN * 2);

    const lines: string[] = [];

    // Header
    const header = `${BOLD}capy edit${RESET}: ${this.state.projectName} ${DIM}(${this.state.branch})${RESET}`;
    lines.push(m + header);
    lines.push('');

    // Top status cells — 4 cells, each exactly a quarter of the available width.
    // The last cell absorbs the remainder so the row fills exactly.
    const topCells = this.buildTopCells();
    const baseCellWidth = Math.floor(available / topCells.length);
    const cellLine1 = topCells
      .map((c, i) => {
        const w = i === topCells.length - 1 ? available - baseCellWidth * (topCells.length - 1) : baseCellWidth;
        return this.pad(c.value, w);
      })
      .join('');
    const cellLine2 = topCells
      .map((c, i) => {
        const w = i === topCells.length - 1 ? available - baseCellWidth * (topCells.length - 1) : baseCellWidth;
        return DIM + this.pad(c.action, w) + RESET;
      })
      .join('');
    lines.push(m + cellLine1);
    lines.push(m + cellLine2);
    lines.push('');

    // Build the single-column table.
    const tableLines = this.buildTable(available);

    // If the popup is open, splice it in after the cursor row.
    // Table layout: [0] "Variables", [1] column header, [2+] data rows.
    if (this.popupOpen && this.state.rows[this.cursorIndex]) {
      const cursorLineIdx = 2 + this.cursorIndex;
      const popupLines = this.buildPopup(available);
      tableLines.splice(cursorLineIdx + 1, 0, ...popupLines);
    }

    // Reserve space for header lines already pushed + footer (2) + status (1)
    const reserved = lines.length + 3;
    const bodyHeight = Math.max(6, termHeight - reserved);

    // Scroll: keep cursor row visible. When popup is open, also try to keep
    // some of the popup visible by scrolling so the cursor sits near the top.
    const cursorLineIdx = 2 + this.cursorIndex;
    if (cursorLineIdx < this.scrollOffset) this.scrollOffset = cursorLineIdx;
    if (cursorLineIdx >= this.scrollOffset + bodyHeight) {
      this.scrollOffset = cursorLineIdx - bodyHeight + 1;
    }
    if (this.popupOpen) {
      // Pin cursor to near the top so the popup (which renders just below)
      // has room. If cursor is already higher up, leave it alone.
      const targetOffset = Math.max(0, cursorLineIdx - 1);
      if (this.scrollOffset < targetOffset && cursorLineIdx >= this.scrollOffset + 3) {
        this.scrollOffset = Math.min(targetOffset, Math.max(0, tableLines.length - bodyHeight));
      }
    }
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    const slice = tableLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    for (const line of slice) {
      lines.push(m + line);
    }

    // Footer
    lines.push('');
    if (this.quitPrompt) {
      const n = this.pendingEdits.size;
      lines.push(`${m}${YELLOW}${n} uncommitted change${n === 1 ? '' : 's'}.${RESET} ${BOLD}c${RESET}${DIM} commit & push · ${RESET}${BOLD}d${RESET}${DIM} discard · ${RESET}${BOLD}k${RESET}${DIM} keep working${RESET}`);
    } else if (this.editing) {
      lines.push(`${m}${DIM}Type new value · ${RESET}${BOLD}Enter${RESET}${DIM} save · ${RESET}${BOLD}Esc${RESET}${DIM} cancel${RESET}`);
    } else if (this.popupOpen) {
      const row = this.state.rows[this.cursorIndex];
      const isRevealed = row ? this.revealed.has(row.key) : false;
      const revealLabel = isRevealed ? 'hide' : 'reveal';
      const panHint = isRevealed ? `${DIM} · ${RESET}${BOLD}←/→${RESET}${DIM} pan${RESET}` : '';
      const dirty = this.pendingEdits.size;
      const dirtyHint = dirty > 0
        ? `${DIM} · ${RESET}${BOLD}c${RESET}${DIM} commit & push (${dirty})${RESET}`
        : '';
      lines.push(`${m}${BOLD}r${RESET}${DIM} ${revealLabel} · ${RESET}${BOLD}e${RESET}${DIM} edit${RESET}${panHint}${dirtyHint}${DIM} · ${RESET}${BOLD}esc${RESET}${DIM} close${RESET}`);
    } else {
      const dirty = this.pendingEdits.size;
      const dirtyHint = dirty > 0
        ? `${DIM} · ${RESET}${BOLD}c${RESET}${DIM} commit & push (${dirty})${RESET}`
        : '';
      lines.push(`${m}${DIM}↑↓ navigate · ${RESET}${BOLD}enter${RESET}${DIM} inspect · ${RESET}${BOLD}r${RESET}${DIM} reveal · ${RESET}${BOLD}e${RESET}${DIM} edit${RESET}${dirtyHint}${DIM} · ${RESET}${BOLD}q${RESET}${DIM} quit${RESET}`);
    }

    if (this.statusMessage) {
      const color = this.statusMessage.isError ? RED : GREEN;
      lines.push(`${m}${color}${this.statusMessage.text}${RESET}`);
    }

    return lines.map((l) => l + CLEAR_EOL).join('\n');
  }

  private buildTopCells(): { value: string; action: string }[] {
    const total = this.state.rows.length;
    let drift = 0;
    let conflicts = 0;
    let unknown = 0;
    for (const r of this.state.rows) {
      if (r.status === 'local' || r.status === 'remote') drift++;
      else if (r.status === 'conflict') conflicts++;
      else if (r.status === 'unknown') unknown++;
    }

    return [
      { value: this.state.branch, action: 'active branch' },
      { value: `${total} tracked`, action: 'shown as abc…xyz snippets' },
      {
        value: this.state.remoteAvailable ? `${drift} drift` : `${unknown} ?`,
        action: this.state.remoteAvailable ? 'changed local/remote' : 'remote unavailable',
      },
      {
        value: `${conflicts} conflicts`,
        action: conflicts > 0 ? 'need resolution' : 'all clear',
      },
    ];
  }

  private buildTable(width: number): string[] {
    const lines: string[] = [];
    lines.push(`${BOLD}Variables${RESET}`);
    // 4 columns: KEY, VALUE, STATUS, UPDATED. UPDATED absorbs slack so the
    // row fills the full width.
    const keyW = Math.max(12, Math.floor(width * 0.32));
    const valW = 14;
    const statusW = 14;
    const gap = '  ';
    const fixed = keyW + valW + statusW + gap.length * 3;
    const updatedW = Math.max(8, width - fixed);

    const headerRow =
      this.pad('KEY', keyW) + gap + this.pad('VALUE', valW) + gap + this.pad('STATUS', statusW) + gap + this.pad('UPDATED', updatedW);
    lines.push(DIM + headerRow + RESET);

    for (let i = 0; i < this.state.rows.length; i++) {
      const row = this.state.rows[i];
      const isSelected = i === this.cursorIndex;
      const pointer = isSelected ? '▶' : ' ';
      const keyCell = this.pad(`${pointer} ${row.key}`, keyW);
      const valCell = this.pad(this.maskedSnippet(row), valW);
      const statusCell = this.padVis(this.statusBadge(row.status), statusW);
      const updatedCell = this.pad(row.updatedLabel, updatedW);
      let line = keyCell + gap + valCell + gap + statusCell + gap + updatedCell;
      if (isSelected && !this.editing) {
        line = INVERSE + this.padVis(line, width) + RESET;
      }
      lines.push(line);
    }

    return lines;
  }

  // Inline popup that splices into the table beneath the cursor row.
  private buildPopup(width: number): string[] {
    const row = this.state.rows[this.cursorIndex];
    if (!row) return [];

    const indent = '  '; // popup is inset 2 cols from the table margin
    const inner = '   '; // content inside the popup is indented 3 more cols
    const ruleWidth = Math.max(10, width - indent.length);
    const rule = `${indent}${DIM}╶${'─'.repeat(ruleWidth - 2)}╴${RESET}`;

    // Width available for value content inside the popup
    const labelW = 9;
    const contentWidth = Math.max(20, ruleWidth - inner.length - 1);
    const valueContentWidth = Math.max(10, contentWidth - labelW);

    const lines: string[] = [];
    lines.push(rule);
    lines.push('');
    lines.push(`${indent}${inner}${BOLD}${this.truncate(row.key, contentWidth)}${RESET}`);
    lines.push('');

    const fieldVal = (label: string, value: string) =>
      `${indent}${inner}${DIM}${this.pad(label, labelW)}${RESET}${value}`;

    lines.push(fieldVal('status', this.statusBadge(row.status)));
    lines.push(fieldVal('updated', row.updatedLabel));
    lines.push('');

    // Value field — always rendered on a single line so mouse-select never
    // captures a wrap-induced newline.
    const valueLine = this.renderValueField(row, valueContentWidth);
    lines.push(fieldVal('value', valueLine));

    lines.push('');
    lines.push(rule);

    return lines;
  }

  // Renders the value field as a single line of at most `width` visible chars.
  // Handles edit mode (shows the buffer with a cursor marker), masked state,
  // and revealed state with horizontal panning when the value overflows.
  private renderValueField(row: EditRow, width: number): string {
    if (this.editing && this.editing.key === row.key) {
      const display = `> ${this.editing.buffer}_`;
      if (display.length <= width) return display;
      // Keep the cursor (end of buffer) visible — clip from the left.
      return '…' + display.slice(display.length - width + 1);
    }

    const isRevealed = this.revealed.has(row.key);
    if (!isRevealed) {
      return this.maskedSnippet(row);
    }

    const value = row.localValue ?? row.remoteValue;
    if (value === undefined) return `${DIM}(no value)${RESET}`;
    if (value === '') return `${DIM}(empty)${RESET}`;

    if (value.length <= width) {
      this.popupPanOffset = 0;
      return value;
    }

    // Need to pan. Reserve 2 cols on each side for indicators (or padding).
    const visibleWidth = Math.max(1, width - 4);
    const maxOffset = Math.max(0, value.length - visibleWidth);
    if (this.popupPanOffset > maxOffset) this.popupPanOffset = maxOffset;
    if (this.popupPanOffset < 0) this.popupPanOffset = 0;

    const leftIndicator = this.popupPanOffset > 0 ? `${DIM}◂${RESET} ` : '  ';
    const rightIndicator = this.popupPanOffset < maxOffset ? ` ${DIM}▸${RESET}` : '  ';
    const slice = value.slice(this.popupPanOffset, this.popupPanOffset + visibleWidth);

    return leftIndicator + slice + rightIndicator;
  }

  private statusBadge(status: EditRow['status']): string {
    switch (status) {
      case 'in sync':
        return `${GREEN}● in sync${RESET}`;
      case 'local':
        return `${YELLOW}● local${RESET}`;
      case 'remote':
        return `${CYAN}● remote${RESET}`;
      case 'conflict':
        return `${RED}● conflict${RESET}`;
      case 'unknown':
      default:
        return `${DIM}● unknown${RESET}`;
    }
  }

  // --- helpers ---

  private pad(str: string, width: number): string {
    const v = this.visLen(str);
    if (v >= width) return this.truncate(str, width);
    return str + ' '.repeat(width - v);
  }

  private padVis(str: string, width: number): string {
    const v = this.visLen(str);
    if (v >= width) return str;
    return str + ' '.repeat(width - v);
  }

  private truncate(str: string, maxLen: number): string {
    // Naive truncate that ignores ANSI for length calculation. If the visible
    // length already fits, return as-is; otherwise strip codes and clip — we
    // accept that color may be lost at the truncation point.
    if (this.visLen(str) <= maxLen) return str;
    const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
    return stripped.slice(0, Math.max(0, maxLen - 1)) + '…';
  }

  private visLen(str: string): number {
    return str.replace(/\x1b\[[0-9;]*m/g, '').length;
  }

  private maskedSnippet(row: EditRow): string {
    const value = row.localValue ?? row.remoteValue;
    if (value === undefined || value === '') return NO_VALUE;
    return formatSnippet(value);
  }
}
