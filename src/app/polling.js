import { useCallback, useEffect, useRef, useState } from 'react';

export function usePollingResource(loader, intervalMs, options = {}) {
  const { enabled = true, immediate = true, initialData = null } = options;
  const loaderRef = useRef(loader);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const dataRef = useRef(initialData);
  const [data, setData] = useState(initialData);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(immediate && enabled && initialData == null));

  useEffect(() => { loaderRef.current = loader; }, [loader]);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    if (dataRef.current == null) setLoading(true);
    try {
      const next = await loaderRef.current();
      if (mountedRef.current) {
        dataRef.current = next;
        setData(next);
        setError('');
      }
      return next;
    } catch (requestError) {
      if (mountedRef.current) setError(requestError?.message || String(requestError));
      return null;
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    if (immediate) refresh();
    const timer = intervalMs > 0 ? window.setInterval(refresh, intervalMs) : null;
    return () => { if (timer) window.clearInterval(timer); };
  }, [enabled, immediate, intervalMs, refresh]);

  return { data, error, loading, refresh };
}

