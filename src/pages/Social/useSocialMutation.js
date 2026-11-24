import { useState } from 'react';

export function useSocialMutation(load, refreshState, setError) {
  const [busy, setBusy] = useState(false);
  async function mutate(work) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
      await refreshState();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, mutate };
}
