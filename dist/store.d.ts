import type { AccountStore, AccountCredentials } from './types.js';
export declare function loadStore(): AccountStore;
export declare function saveStore(store: AccountStore): void;
export declare function mutateStore<T>(mutator: (store: AccountStore) => T): {
    store: AccountStore;
    result: T;
};
export declare function withWriteLock<T>(fn: () => T): Promise<T>;
export declare function getStoreDiagnostics(): {
    storeDir: string;
    storeFile: string;
    locked: boolean;
    encrypted: boolean;
    writeLocked: boolean;
    error: string | null;
};
export declare function addAccount(alias: string, creds: Omit<AccountCredentials, 'alias' | 'usageCount'>): AccountStore;
export declare function removeAccount(alias: string): AccountStore;
export declare function updateAccount(alias: string, updates: Partial<AccountCredentials>): AccountStore;
export declare function updateAccountInStore(store: AccountStore, alias: string, updates: Partial<AccountCredentials>): void;
export declare function setActiveAlias(alias: string | null): AccountStore;
export declare function getActiveAccount(): AccountCredentials | null;
export declare function listAccounts(): AccountCredentials[];
export declare function getStorePath(): string;
export declare function getStoreStatus(): {
    locked: boolean;
    encrypted: boolean;
    writeLocked: boolean;
    error: string | null;
};
//# sourceMappingURL=store.d.ts.map