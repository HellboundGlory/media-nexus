// SPDX-License-Identifier: MIT
/** Authenticated identity attached to the request by the API key guard. */
export interface Principal {
  keyId: string;
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
