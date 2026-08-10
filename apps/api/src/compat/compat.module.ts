// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { CompatService } from "./compat.service";
import { SystemModule } from "../system/system.module";

@Module({ imports: [SystemModule], providers: [CompatService], exports: [CompatService] })
export class CompatModule {}
