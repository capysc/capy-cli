/**
 * Simple spinner implementation without dependencies
 * Replaces ora to avoid chalk dependency
 */

export class Spinner {
  public text: string;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private currentFrame = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private isSpinning = false;
  // Progress/status is NOT program data. When stdout is a TTY we keep the animated
  // spinner on stdout (unchanged human UX); when stdout is piped (non-TTY — e.g. a
  // `--json` consumer), progress goes to STDERR so stdout stays pure JSON. This is
  // the source-level fix for the `--json` machine-output contract (CAP-273); ora
  // itself writes progress to stderr for the same reason.
  private readonly tty = process.stdout.isTTY === true;
  private get stream(): NodeJS.WriteStream {
    return this.tty ? process.stdout : process.stderr;
  }

  constructor(text: string) {
    this.text = text;
  }

  start(): this {
    if (this.isSpinning) return this;

    this.isSpinning = true;
    if (!this.tty) {
      // No animation off-TTY (carriage-return redraw is meaningless when piped);
      // emit a single progress line to stderr instead.
      this.stream.write(`${this.text}\n`);
      return this;
    }
    this.render();

    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.render();
    }, 80);

    return this;
  }

  private render(): void {
    if (!this.isSpinning || !this.tty) return;

    process.stdout.write('\r\x1b[K'); // Clear line
    process.stdout.write(`${this.frames[this.currentFrame]} ${this.text}`);
  }

  stop(): void {
    if (!this.isSpinning) return;

    this.isSpinning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.tty) this.stream.write('\r\x1b[K'); // Clear line (TTY only)
  }

  succeed(text?: string): void {
    this.stop();
    this.stream.write(`\x1b[32m✓\x1b[0m ${text || this.text}\n`); // Green checkmark
  }

  fail(text?: string): void {
    this.stop();
    this.stream.write(`\x1b[31m✗\x1b[0m ${text || this.text}\n`); // Red X
  }

  warn(text?: string): void {
    this.stop();
    this.stream.write(`\x1b[33m⚠\x1b[0m ${text || this.text}\n`); // Yellow warning
  }
}

/**
 * Factory function to match ora's API
 */
export default function ora(text: string): Spinner {
  return new Spinner(text);
}
