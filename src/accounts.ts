export interface AccountConnection { id: string; provider: string; name: string; email?: string | null }

/** Keep numbers stable across reconnects/restarts; never recycle a removed account's slot. */
export function assignAccounts(connections: AccountConnection[], assignments: Record<string, string>,
  preferred: Record<string, string | undefined>) {
  const next = { ...assignments };
  for (const family of ["claude", "codex"]) {
    const accounts = connections.filter(c => c.provider === family);
    for (const key of [family, `${family}2`]) {
      if (next[key]) continue;
      const identifier = preferred[key];
      const account = accounts.find(c => !Object.values(next).includes(c.id) &&
        (identifier ? [c.id, c.email, c.name].includes(identifier) : true));
      if (account) next[key] = account.id;
    }
    for (const account of accounts) {
      if (Object.values(next).includes(account.id)) continue;
      let n = 3;
      while (next[`${family}${n}`]) n++;
      next[`${family}${n}`] = account.id;
    }
  }
  return next;
}
