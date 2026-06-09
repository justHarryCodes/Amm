'use client';
import { useEffect, useRef, useCallback, useState } from 'react';

type Listener = (data: unknown) => void;

export function useSSE() {
  const listeners = useRef<Map<string, Listener[]>>(new Map());
  const [connected, setConnected] = useState(false);

  const on = useCallback((type: string, fn: Listener) => {
    if (!listeners.current.has(type)) listeners.current.set(type, []);
    listeners.current.get(type)!.push(fn);
    return () => {
      const arr = listeners.current.get(type) ?? [];
      listeners.current.set(type, arr.filter(f => f !== fn));
    };
  }, []);

  useEffect(() => {
    let es: EventSource;
    let timer: ReturnType<typeof setTimeout>;

    function connect() {
      const key = typeof window !== 'undefined'
        ? (localStorage.getItem('api_key') ?? process.env.NEXT_PUBLIC_API_KEY ?? '')
        : '';
      es = new EventSource(`/api/events?key=${encodeURIComponent(key)}`);

      es.onopen  = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es.close();
        timer = setTimeout(connect, 3000);
      };
      es.onmessage = (evt) => {
        try {
          const { type, data } = JSON.parse(evt.data as string) as { type: string; data: unknown };
          (listeners.current.get(type) ?? []).forEach(fn => fn(data));
        } catch { /* ignore */ }
      };
    }

    connect();
    return () => { clearTimeout(timer); es?.close(); };
  }, []);

  return { connected, on };
}
