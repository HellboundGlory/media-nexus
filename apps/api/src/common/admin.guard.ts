// SPDX-License-Identifier: MIT
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ApiError } from "@medianexus/shared";
import type { Principal } from "./principal";

/** Guard for admin-only routes (e.g. user management, global settings writes). */
@Injectable()
export class AdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const principal = req.principal as Principal | undefined;
    if (!principal?.isAdmin) {
      throw new ApiError({ code: "FORBIDDEN", message: "Admin privileges required" });
    }
    return true;
  }
}
