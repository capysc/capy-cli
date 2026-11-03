import terminalSpinner from './spinner';
import { currentInteraction } from './interaction';

interface FlowSpinner {
  readonly text: string;
  readonly start: () => FlowSpinner;
  readonly stop: () => void;
  readonly succeed: (text?: string) => void;
  readonly fail: (text?: string) => void;
  readonly warn: (text?: string) => void;
}

export default function spinner(text: string, quiet = false): FlowSpinner {
  const interaction = currentInteraction();
  if (!interaction) return terminalSpinner(text, quiet);
  const emit = (status: 'start' | 'success' | 'failure' | 'warning', value = text): void => {
    if (quiet && status !== 'failure' && status !== 'warning') return;
    void Promise.resolve(interaction.progress({ status, text: value })).catch(() => undefined);
  };
  const instance: FlowSpinner = { text, start: () => { emit('start'); return instance; }, stop: () => undefined,
    succeed: value => emit('success', value), fail: value => emit('failure', value), warn: value => emit('warning', value) };
  return instance;
}
