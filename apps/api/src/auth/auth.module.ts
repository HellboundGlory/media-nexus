// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { ApiKeyGuard } from "./api-key.guard";
import { BootstrapService } from "./bootstrap.service";

@Module({
  providers: [AuthService, ApiKeyGuard, BootstrapService],
  controllers: [AuthController],
  exports: [AuthService, ApiKeyGuard],
})
export class AuthModule {}
