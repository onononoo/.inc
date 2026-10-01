/**
 * Counters for things the security layer refused. They only ever grow during a run, are held in
 * memory, and are reported by the diagnostics text so an administrator can verify that web
 * content tried (and failed) to reach the network.
 */
let blockedRequests = 0;
let blockedNavigations = 0;

export const securityStats = {
  recordBlockedRequest(): void {
    blockedRequests++;
  },
  recordBlockedNavigation(): void {
    blockedNavigations++;
  },
  blockedRequests(): number {
    return blockedRequests;
  },
  blockedNavigations(): number {
    return blockedNavigations;
  },
};
