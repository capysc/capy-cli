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

  constructor(text: string) {
    this.text = text;
  }

  start(): this {
    if (this.isSpinning) return this;

    this.isSpinning = true;
    this.render();

    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.render();
    }, 80);

    return this;
  }

  private render(): void {
    if (!this.isSpinning) return;

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
    process.stdout.write('\r\x1b[K'); // Clear line
  }

  succeed(text?: string): void {
    this.stop();
    console.log(`\x1b[32m✓\x1b[0m ${text || this.text}`); // Green checkmark
  }

  fail(text?: string): void {
    this.stop();
    console.log(`\x1b[31m✗\x1b[0m ${text || this.text}`); // Red X
  }
}

/**
 * Factory function to match ora's API
 */
export default function ora(text: string): Spinner {
  return new Spinner(text);
}
