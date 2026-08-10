// SPDX-License-Identifier: MIT
/** Authenticated identity attached to the request by the API key guard. */
export interface Principal {
  keyId: string;
  userId: string | null;
  username: string | null;
  isAdmin: boolean;
  scopes: string[];
}

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
      correlationId?: string;
    }
  }
}

export {};
