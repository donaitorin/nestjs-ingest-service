export const leaseExpiry = (leaseMs: number): Date => new Date(Date.now() + leaseMs);
