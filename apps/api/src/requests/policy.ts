// SPDX-License-Identifier: MIT
import type { Principal } from "../common/principal";

/** Request policy (Seerr-style, pragmatic): ADMIN auto-approves and can moderate. */
export function canAutoApprove(p: Principal | undefined): boolean {
  return p?.isAdmin === true;
}

export function canModerateRequests(p: Principal | undefined): boolean {
  return p?.isAdmin === true;
}

export function isAdmin(p: Principal | undefined): boolean {
  return p?.isAdmin === true;
}

/** Whether a principal may fetch requests (admins see all; others their own). */
export function canSeeAllRequests(p: Principal | undefined): boolean {
  return p?.isAdmin === true;
}
