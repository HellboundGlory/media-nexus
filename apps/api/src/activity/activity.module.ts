// SPDX-License-Identifier: MIT
import { Module } from "@nestjs/common";
import { ActivityController } from "./activity.controller";
import { ActivityService } from "./activity.service";
import { AcquisitionModule } from "../acquisition/acquisition.module";

// Imports AcquisitionModule so ActivityController can drive retry/manual-import through
// AcquisitionService. Acyclic: AcquisitionModule depends on series/movies/indexers, none
// of which depend on Activity.
@Module({ controllers: [ActivityController], providers: [ActivityService], imports: [AcquisitionModule] })
export class ActivityModule {}
