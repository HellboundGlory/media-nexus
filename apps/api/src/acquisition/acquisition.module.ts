// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { AcquisitionService } from "./acquisition.service";

@Module({
  providers: [AcquisitionService],
  exports: [AcquisitionService],
})
export class AcquisitionModule {}
