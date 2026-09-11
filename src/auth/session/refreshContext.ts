import { AsyncLocalStorage } from 'async_hooks';

export type RefreshRotationContext = Readonly<{
  fenceId: string;
  beginRotation: () => void;
}>;

const refreshRotationContext = new AsyncLocalStorage<RefreshRotationContext>();

export const runWithRefreshRotationContext = <T>(
  context: RefreshRotationContext,
  run: () => Promise<T>,
): Promise<T> => refreshRotationContext.run(context, run);

export const currentRefreshRotationContext = (): RefreshRotationContext | undefined =>
  refreshRotationContext.getStore();

export const beginRefreshRotationIfPresent = (): void => {
  currentRefreshRotationContext()?.beginRotation();
};
