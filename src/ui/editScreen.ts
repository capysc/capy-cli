// Two-pane TUI for `capy edit`: variable list on the left, inspector on the right.
// Built on raw stdin + ANSI codes so we don't add a TUI dependency.

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
const SEPARATOR = ' │ ';
const MIN_TWO_PANE_WIDTH = 80;
const MIN_RIGHT_WIDTH = 28;
const MASK = '****';

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

    // Arrow up
    if (key === `${ESC}[A`) {
      if (this.cursorIndex > 0) {
        this.cursorIndex--;
        this.draw();
      }
      return;
    }

    // Arrow down
    if (key === `${ESC}[B`) {
      if (this.cursorIndex < this.state.rows.length - 1) {
        this.cursorIndex++;
        this.draw();
      }
      return;
    }

    if (key === 'r' || key === 'R') {
      const row = this.state.rows[this.cursorIndex];
      if (!row) return;
      if (this.revealed.has(row.key)) this.revealed.delete(row.key);
      else this.revealed.add(row.key);
      this.draw();
      return;
    }

    if (key === 'e' || key === 'E') {
      const row = this.state.rows[this.cursorIndex];
      if (!row) return;
      this.editing = { key: row.key, buffer: row.localValue ?? '' };
      this.statusMessage = null;
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
    const twoPane = available >= MIN_TWO_PANE_WIDTH;

    let leftWidth: number;
    let rightWidth: number;
    if (twoPane) {
      leftWidth = Math.max(50, Math.floor((available - SEPARATOR.length) * 0.6));
      rightWidth = available - SEPARATOR.length - leftWidth;
      if (rightWidth < MIN_RIGHT_WIDTH) {
        leftWidth = available - SEPARATOR.length - MIN_RIGHT_WIDTH;
        rightWidth = MIN_RIGHT_WIDTH;
      }
    } else {
      leftWidth = available;
      rightWidth = 0;
    }

    const lines: string[] = [];

    // Header
    const header = `${BOLD}capy edit${RESET}: ${this.state.projectName} ${DIM}(${this.state.branch})${RESET}`;
    lines.push(m + header);
    lines.push('');

    // Top status cells (4 borderless 2-line cells, spread across the full content width)
    const topCells = this.buildTopCells();
    const topWidth = available;
    const cellWidth = Math.floor(topWidth / topCells.length);
    const cellLine1 = topCells.map((c) => this.pad(c.value, cellWidth)).join('');
    const cellLine2 = topCells.map((c) => DIM + this.pad(c.action, cellWidth) + RESET).join('');
    lines.push(m + cellLine1);
    lines.push(m + cellLine2);
    lines.push('');

    // Build left pane lines (variables table)
    const leftLines = this.buildLeftPane(leftWidth);
    // Build right pane lines (inspector)
    const rightLines = twoPane ? this.buildRightPane(rightWidth) : [];

    // Reserve space for header (~5 lines used so far) + footer (3) + status (2)
    const reserved = lines.length + 4;
    const bodyHeight = Math.max(6, termHeight - reserved);

    // Adjust scroll so cursor row stays visible. The cursor lands on
    // leftPaneRowToLineIndex(cursorIndex) once we know the body header offset.
    const tableHeaderRows = 2; // "Variables" line + column header line + rule
    const cursorLineInLeft = tableHeaderRows + 1 + this.cursorIndex;
    if (cursorLineInLeft < this.scrollOffset) this.scrollOffset = cursorLineInLeft;
    if (cursorLineInLeft >= this.scrollOffset + bodyHeight) {
      this.scrollOffset = cursorLineInLeft - bodyHeight + 1;
    }
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    const leftSlice = leftLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    const rightSlice = rightLines.slice(0, bodyHeight);

    const rowCount = Math.max(leftSlice.length, rightSlice.length);
    for (let i = 0; i < rowCount; i++) {
      const left = leftSlice[i] ?? '';
      const right = rightSlice[i] ?? '';
      if (twoPane) {
        lines.push(m + this.padVis(left, leftWidth) + DIM + SEPARATOR + RESET + right);
      } else {
        lines.push(m + left);
      }
    }

    // Footer
    lines.push('');
    if (this.quitPrompt) {
      const n = this.pendingEdits.size;
      lines.push(`${m}${YELLOW}${n} uncommitted change${n === 1 ? '' : 's'}.${RESET} ${BOLD}c${RESET}${DIM} commit & push · ${RESET}${BOLD}d${RESET}${DIM} discard · ${RESET}${BOLD}k${RESET}${DIM} keep working${RESET}`);
    } else if (this.editing) {
      lines.push(`${m}${DIM}Type new value · ${RESET}${BOLD}Enter${RESET}${DIM} save · ${RESET}${BOLD}Esc${RESET}${DIM} cancel${RESET}`);
    } else {
      const dirty = this.pendingEdits.size;
      const dirtyHint = dirty > 0
        ? `${DIM} · ${RESET}${BOLD}c${RESET}${DIM} commit & push (${dirty})${RESET}`
        : '';
      lines.push(`${m}${DIM}↑↓ navigate · ${RESET}${BOLD}r${RESET}${DIM} reveal · ${RESET}${BOLD}e${RESET}${DIM} edit${RESET}${dirtyHint}${DIM} · ${RESET}${BOLD}q${RESET}${DIM} quit${RESET}`);
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
      { value: `${total} tracked`, action: 'values stay masked' },
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

  private buildLeftPane(width: number): string[] {
    const lines: string[] = [];
    lines.push(`${BOLD}Variables${RESET}`);
    // 4 columns: KEY, VALUE, STATUS, UPDATED
    const keyW = Math.max(12, Math.floor(width * 0.38));
    const valW = 6; // "****" + padding
    const statusW = 12;
    const updatedW = Math.max(8, width - keyW - valW - statusW - 6); // 6 for gaps

    const gap = '  ';
    const headerRow =
      this.pad('KEY', keyW) + gap + this.pad('VALUE', valW) + gap + this.pad('STATUS', statusW) + gap + this.pad('UPDATED', updatedW);
    lines.push(DIM + headerRow + RESET);

    for (let i = 0; i < this.state.rows.length; i++) {
      const row = this.state.rows[i];
      const isSelected = i === this.cursorIndex && !this.editing;
      const pointer = isSelected ? '▶' : ' ';
      const keyCell = this.pad(`${pointer} ${row.key}`, keyW);
      const valCell = this.pad(MASK, valW);
      const statusCell = this.padVis(this.statusBadge(row.status), statusW);
      const updatedCell = this.pad(row.updatedLabel, updatedW);
      let line = keyCell + gap + valCell + gap + statusCell + gap + updatedCell;
      if (isSelected) {
        line = INVERSE + this.padVis(line, width) + RESET;
      }
      lines.push(line);
    }

    return lines;
  }

  private buildRightPane(width: number): string[] {
    const lines: string[] = [];
    const row = this.state.rows[this.cursorIndex];
    if (!row) {
      lines.push(DIM + 'No variables to inspect' + RESET);
      return lines;
    }

    lines.push(BOLD + this.truncate(row.key, width) + RESET);
    lines.push('');

    const labelW = 9;
    const fieldVal = (label: string, value: string) =>
      DIM + this.pad(label, labelW) + RESET + this.truncate(value, width - labelW);

    lines.push(fieldVal('status', this.statusBadge(row.status)));
    lines.push(fieldVal('updated', row.updatedLabel));
    lines.push('');

    lines.push(DIM + 'value' + RESET);

    if (this.editing && this.editing.key === row.key) {
      const display = `> ${this.editing.buffer}_`;
      lines.push(...this.wrap(display, width));
    } else {
      const isRevealed = this.revealed.has(row.key);
      if (isRevealed) {
        if (row.localValue !== undefined) {
          lines.push(...this.wrap(row.localValue, width));
        } else if (row.remoteValue !== undefined) {
          lines.push(`${DIM}(remote)${RESET}`);
          lines.push(...this.wrap(row.remoteValue, width));
        } else {
          lines.push(`${DIM}(no value)${RESET}`);
        }
      } else {
        lines.push(MASK);
      }
    }

    lines.push('');
    if (this.editing && this.editing.key === row.key) {
      // Footer line is rendered globally; no extra hint here
    } else {
      const revealLabel = this.revealed.has(row.key) ? 'hide' : 'reveal';
      lines.push(`${BOLD}r${RESET}${DIM} ${revealLabel}   ${RESET}${BOLD}e${RESET}${DIM} edit${RESET}`);
    }

    return lines;
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

  private wrap(str: string, width: number): string[] {
    if (width <= 0) return [str];
    const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
    if (stripped.length <= width) return [str];
    const out: string[] = [];
    for (let i = 0; i < stripped.length; i += width) {
      out.push(stripped.slice(i, i + width));
    }
    return out;
  }
}
