"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface UsePollingResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  lastUpdate: number;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number = 2000,
): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(0);
  const activeRef = useRef(true);

  const poll = useCallback(async () => {
    try {
      const result = await fetcher();
      if (activeRef.current) {
        setData(result);
        setError(null);
        setStale(false);
        setLastUpdate(Date.now());
        setLoading(false);
      }
    } catch (e) {
      if (activeRef.current) {
        setError((e as Error).message);
        setStale(true);
        setLoading(false);
      }
    }
  }, [fetcher]);

  useEffect(() => {
    activeRef.current = true;
    setLoading(true);
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      activeRef.current = false;
      clearInterval(id);
    };
  }, [poll, intervalMs]);

  return { data, loading, error, stale, lastUpdate, refresh: poll };
}
