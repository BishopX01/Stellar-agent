'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Supported Stellar wallet providers.
 */
export type WalletProvider = 'freighter' | 'xbull' | 'albedo';

/**
 * Connection status of the wallet.
 */
export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Options accepted by the {@link useWallet} hook.
 */
export interface UseWalletOptions {
  /**
   * Provider to attempt to auto-connect on mount (if a previous session exists).
   */
  autoConnect?: boolean;
  /**
   * localStorage key used to persist the last selected provider.
   * @default 'marc-stellar:wallet-provider'
   */
  storageKey?: string;
  /**
   * Called after a successful connection.
   */
  onConnect?: (address: string, provider: WalletProvider) => void;
  /**
   * Called after a successful disconnection.
   */
  onDisconnect?: () => void;
  /**
   * Called when a connection attempt fails.
   */
  onError?: (error: Error) => void;
}

/**
 * Result returned by the {@link useWallet} hook.
 */
export interface UseWalletResult {
  /** Connected public key, or null when disconnected. */
  address: string | null;
  /** Current balance (in lumens) as a string, or null when unavailable. */
  balance: string | null;
  /** Currently selected provider, or null when none selected. */
  provider: WalletProvider | null;
  /** Current connection status. */
  status: WalletStatus;
  /** Whether the hook has mounted on the client (SSR-safe flag). */
  isMounted: boolean;
  /** Whether a connection attempt is in progress. */
  isConnecting: boolean;
  /** Whether a wallet is currently connected. */
  isConnected: boolean;
  /** Last error encountered, if any. */
  error: Error | null;
  /** Connect to the given provider. */
  connect: (provider: WalletProvider) => Promise<void>;
  /** Disconnect the current wallet. */
  disconnect: () => Promise<void>;
  /** Switch to a different provider (disconnects current, then connects). */
  switchWallet: (provider: WalletProvider) => Promise<void>;
  /** Refresh the balance for the connected address. */
  refreshBalance: () => Promise<void>;
}

const DEFAULT_STORAGE_KEY = 'marc-stellar:wallet-provider';

const isBrowser = (): boolean => typeof window !== 'undefined';

const safeGetStorage = (key: string): string | null => {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSetStorage = (key: string, value: string): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore storage errors (private mode, quota, etc.) */
  }
};

const safeRemoveStorage = (key: string): void => {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
};

const isWalletProvider = (value: unknown): value is WalletProvider =>
  value === 'freighter' || value === 'xbull' || value === 'albedo';

/**
 * Minimal shape of the provider-specific window globals we interact with.
 * These are intentionally typed loosely to avoid hard dependencies on the
 * individual wallet SDKs at runtime.
 */
interface FreighterApi {
  isConnected?: () => Promise<boolean>;
  requestAccess?: () => Promise<{ address?: string } | string>;
  getPublicKey?: () => Promise<string>;
  getAddress?: () => Promise<{ address?: string } | string>;
  signTransaction?: (...args: unknown[]) => Promise<unknown>;
}

interface XBullApi {
  connect?: () => Promise<{ publicKey?: string } | string>;
  getPublicKey?: () => Promise<string>;
  disconnect?: () => Promise<void>;
}

interface AlbedoApi {
  publicKey?: (opts?: Record<string, unknown>) => Promise<{ pubkey?: string } | string>;
}

interface WalletWindow extends Window {
  freighterApi?: FreighterApi;
  freighter?: FreighterApi;
  xBullSDK?: XBullApi;
  albedo?: AlbedoApi;
}

const getWalletWindow = (): WalletWindow | null =>
  isBrowser() ? (window as unknown as WalletWindow) : null;

const extractAddress = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.address === 'string') return obj.address;
    if (typeof obj.publicKey === 'string') return obj.publicKey;
    if (typeof obj.pubkey === 'string') return obj.pubkey;
  }
  return null;
};

/**
 * Connect to Freighter and return the public key.
 */
const connectFreighter = async (): Promise<string> => {
  const win = getWalletWindow();
  const api = win?.freighterApi ?? win?.freighter;
  if (!api) {
    throw new Error('Freighter wallet is not installed.');
  }
  if (typeof api.requestAccess === 'function') {
    const result = await api.requestAccess();
    const address = extractAddress(result);
    if (address) return address;
  }
  if (typeof api.getAddress === 'function') {
    const address = extractAddress(await api.getAddress());
    if (address) return address;
  }
  if (typeof api.getPublicKey === 'function') {
    const address = extractAddress(await api.getPublicKey());
    if (address) return address;
  }
  throw new Error('Unable to retrieve address from Freighter.');
};

/**
 * Connect to xBull and return the public key.
 */
const connectXBull = async (): Promise<string> => {
  const win = getWalletWindow();
  const api = win?.xBullSDK;
  if (!api) {
    throw new Error('xBull wallet is not installed.');
  }
  if (typeof api.connect === 'function') {
    const address = extractAddress(await api.connect());
    if (address) return address;
  }
  if (typeof api.getPublicKey === 'function') {
    const address = extractAddress(await api.getPublicKey());
    if (address) return address;
  }
  throw new Error('Unable to retrieve address from xBull.');
};

/**
 * Connect to Albedo and return the public key.
 */
const connectAlbedo = async (): Promise<string> => {
  const win = getWalletWindow();
  const api = win?.albedo;
  if (!api || typeof api.publicKey !== 'function') {
    throw new Error('Albedo wallet is not available.');
  }
  const address = extractAddress(await api.publicKey());
  if (address) return address;
  throw new Error('Unable to retrieve address from Albedo.');
};

const connectProvider = async (provider: WalletProvider): Promise<string> => {
  switch (provider) {
    case 'freighter':
      return connectFreighter();
    case 'xbull':
      return connectXBull();
    case 'albedo':
      return connectAlbedo();
    default:
      throw new Error(`Unsupported wallet provider: ${String(provider)}`);
  }
};

/**
 * Fetch the balance for a Stellar address using Horizon.
 * Returns null when the account is unfunded or the request fails.
 */
const fetchBalance = async (address: string): Promise<string | null> => {
  if (!isBrowser() || typeof fetch !== 'function') return null;
  try {
    const response = await fetch(
      `https://horizon.stellar.org/accounts/${encodeURIComponent(address)}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      balances?: Array<{ asset_type?: string; balance?: string }>;
    };
    const native = data.balances?.find((b) => b.asset_type === 'native');
    return native?.balance ?? null;
  } catch {
    return null;
  }
};

/**
 * React hook that manages Stellar wallet connection state.
 *
 * SSR-safe: all state initializes to deterministic defaults and only updates
 * after mount, so server and client renders match. All `window`/`localStorage`
 * access is guarded with `typeof window !== 'undefined'` checks.
 */
export function useWallet(options: UseWalletOptions = {}): UseWalletResult {
  const {
    autoConnect = false,
    storageKey = DEFAULT_STORAGE_KEY,
    onConnect,
    onDisconnect,
    onError,
  } = options;

  // SSR-safe defaults: everything null/false until mounted on the client.
  const [isMounted, setIsMounted] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [provider, setProvider] = useState<WalletProvider | null>(null);
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [error, setError] = useState<Error | null>(null);

  // Keep latest callbacks in refs to avoid stale closures without re-running effects.
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onConnectRef.current = onConnect;
  }, [onConnect]);

  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const refreshBalance = useCallback(async () => {
    if (!address) {
      setBalance(null);
      return;
    }
    const next = await fetchBalance(address);
    setBalance(next);
  }, [address]);

  const connect = useCallback(
    async (nextProvider: WalletProvider) => {
      if (!isWalletProvider(nextProvider)) {
        const err = new Error(`Unsupported wallet provider: ${String(nextProvider)}`);
        setError(err);
        setStatus('error');
        onErrorRef.current?.(err);
        return;
      }

      setStatus('connecting');
      setError(null);
      setProvider(nextProvider);

      try {
        const nextAddress = await connectProvider(nextProvider);
        setAddress(nextAddress);
        setStatus('connected');
        safeSetStorage(storageKey, nextProvider);
        onConnectRef.current?.(nextAddress, nextProvider);

        const nextBalance = await fetchBalance(nextAddress);
        setBalance(nextBalance);
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        setAddress(null);
        setBalance(null);
        setStatus('error');
        setError(normalized);
        onErrorRef.current?.(normalized);
      }
    },
    [storageKey]
  );

  const disconnect = useCallback(async () => {
    setAddress(null);
    setBalance(null);
    setProvider(null);
    setStatus('disconnected');
    setError(null);
    safeRemoveStorage(storageKey);
    onDisconnectRef.current?.();
  }, [storageKey]);

  const switchWallet = useCallback(
    async (nextProvider: WalletProvider) => {
      await disconnect();
      await connect(nextProvider);
    },
    [connect, disconnect]
  );

  // Mount effect: mark as mounted and optionally auto-connect from stored provider.
  useEffect(() => {
    setIsMounted(true);

    if (!isBrowser()) return;

    if (autoConnect) {
      const stored = safeGetStorage(storageKey);
      if (isWalletProvider(stored)) {
        void connect(stored);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isConnecting = status === 'connecting';
  const isConnected = status === 'connected' && address !== null;

  return useMemo<UseWalletResult>(
    () => ({
      address,
      balance,
      provider,
      status,
      isMounted,
      isConnecting,
      isConnected,
      error,
      connect,
      disconnect,
      switchWallet,
      refreshBalance,
    }),
    [
      address,
      balance,
      provider,
      status,
      isMounted,
      isConnecting,
      isConnected,
      error,
      connect,
      disconnect,
      switchWallet,
      refreshBalance,
    ]
  );
}

export default useWallet;