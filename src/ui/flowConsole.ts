import { format, stripVTControlCharacters } from 'node:util';
import { currentInteraction } from './interaction';

const output = (level: 'info' | 'warning' | 'error', values: readonly unknown[]): void => {
  const interaction = currentInteraction();
  if (!interaction) {
    const write = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
    write(...values);
    return;
  }
  // Queue failures are also propagated by the flow's writer/controller.
  void Promise.resolve(interaction.output({ text: stripVTControlCharacters(format(...values)), level })).catch(() => undefined);
};
export const flowConsole = {
  log: (...values: readonly unknown[]): void => output('info', values),
  warn: (...values: readonly unknown[]): void => output('warning', values),
  error: (...values: readonly unknown[]): void => output('error', values),
} as const;
