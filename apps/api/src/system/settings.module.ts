// SPDX-License-Identifier: MIT
import { Global, Module } from "@nestjs/common";
import { ConfigService } from "./config.service";

/** Global settings provider (admin-editable runtime config) —
 *  kept separate from SystemModule to avoid module cycles (jobs/acquisition/indexers need it). */
@Global()
@Module({ providers: [ConfigService], exports: [ConfigService] })
export class SettingsModule {}
