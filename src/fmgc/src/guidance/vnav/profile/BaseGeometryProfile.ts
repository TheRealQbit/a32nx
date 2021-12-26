import { Common } from '@fmgc/guidance/vnav/common';
import { VnavConfig } from '@fmgc/guidance/vnav/VnavConfig';
import { PseudoWaypointFlightPlanInfo } from '@fmgc/guidance/PseudoWaypoint';
import { MaxAltitudeConstraint, MaxSpeedConstraint, VerticalCheckpoint, VerticalCheckpointReason } from '@fmgc/guidance/vnav/profile/NavGeometryProfile';

export abstract class BaseGeometryProfile {
    public isReadyToDisplay: boolean = false;

    public checkpoints: VerticalCheckpoint[] = [];

    abstract maxSpeedConstraints: MaxSpeedConstraint[];

    abstract maxAltitudeConstraints: MaxAltitudeConstraint[];

    abstract distanceToPresentPosition: NauticalMiles;

    get lastCheckpoint(): VerticalCheckpoint | null {
        if (this.checkpoints.length < 1) {
            return null;
        }

        return this.checkpoints[this.checkpoints.length - 1];
    }

    addCheckpointFromLast(checkpointBuilder: (lastCheckpoint: VerticalCheckpoint) => Partial<VerticalCheckpoint>) {
        this.checkpoints.push({ ...this.lastCheckpoint, ...checkpointBuilder(this.lastCheckpoint) });
    }

    predictAtTime(secondsFromPresent: Seconds): PseudoWaypointFlightPlanInfo {
        const distanceFromStart = this.interpolateDistanceAtTime(secondsFromPresent);
        const { altitude, speed } = this.interpolateEverythingFromStart(distanceFromStart);

        return {
            distanceFromStart,
            altitude,
            speed,
            secondsFromPresent,
        };
    }

    private interpolateFromCheckpoints<T extends number, U extends number>(
        indexValue: T, keySelector: (checkpoint: VerticalCheckpoint) => T, valueSelector: (checkpoint: VerticalCheckpoint) => U,
    ) {
        if (indexValue < keySelector(this.checkpoints[0])) {
            return valueSelector(this.checkpoints[0]);
        }

        for (let i = 0; i < this.checkpoints.length - 1; i++) {
            if (indexValue >= keySelector(this.checkpoints[i]) && indexValue < keySelector(this.checkpoints[i + 1])) {
                return Common.interpolate(
                    indexValue,
                    keySelector(this.checkpoints[i]),
                    keySelector(this.checkpoints[i + 1]),
                    valueSelector(this.checkpoints[i]),
                    valueSelector(this.checkpoints[i + 1]),
                );
            }
        }

        return valueSelector(this.checkpoints[this.checkpoints.length - 1]);
    }

    /**
     * Find the time from start at which the profile predicts us to be at a distance along the flightplan.
     * @param distanceFromStart Distance along that path
     * @returns Predicted altitude
     */
    interpolateTimeAtDistance(distanceFromStart: NauticalMiles): Seconds {
        return this.interpolateFromCheckpoints(distanceFromStart, (checkpoint) => checkpoint.distanceFromStart, (checkpoint) => checkpoint.secondsFromPresent);
    }

    /**
     * Find the altitude at which the profile predicts us to be at a distance along the flightplan.
     * @param distanceFromStart Distance along that path
     * @returns Predicted altitude
     */
    interpolateAltitudeAtDistance(distanceFromStart: NauticalMiles): Feet {
        return this.interpolateFromCheckpoints(distanceFromStart, (checkpoint) => checkpoint.distanceFromStart, (checkpoint) => checkpoint.altitude);
    }

    /**
     * Find the altitude at which the profile predicts us to be at a distance along the flightplan.
     * @param distanceFromStart Distance along that path
     * @returns Predicted altitude
     */
    interpolateDistanceAtTime(secondsFromPresent: Seconds): NauticalMiles {
        return this.interpolateFromCheckpoints(secondsFromPresent, (checkpoint) => checkpoint.secondsFromPresent, (checkpoint) => checkpoint.distanceFromStart);
    }

    interpolateEverythingFromStart(distanceFromStart: NauticalMiles): Omit<VerticalCheckpoint, 'reason'> {
        if (distanceFromStart <= this.checkpoints[0].distanceFromStart) {
            return {
                distanceFromStart,
                secondsFromPresent: this.checkpoints[0].secondsFromPresent,
                altitude: this.checkpoints[0].altitude,
                remainingFuelOnBoard: this.checkpoints[0].remainingFuelOnBoard,
                speed: this.checkpoints[0].speed,
            };
        }

        for (let i = 0; i < this.checkpoints.length - 1; i++) {
            if (distanceFromStart > this.checkpoints[i].distanceFromStart && distanceFromStart <= this.checkpoints[i + 1].distanceFromStart) {
                return {
                    distanceFromStart,
                    secondsFromPresent: Common.interpolate(
                        distanceFromStart,
                        this.checkpoints[i].distanceFromStart,
                        this.checkpoints[i + 1].distanceFromStart,
                        this.checkpoints[i].secondsFromPresent,
                        this.checkpoints[i + 1].secondsFromPresent,
                    ),
                    altitude: Common.interpolate(
                        distanceFromStart,
                        this.checkpoints[i].distanceFromStart,
                        this.checkpoints[i + 1].distanceFromStart,
                        this.checkpoints[i].altitude,
                        this.checkpoints[i + 1].altitude,
                    ),
                    remainingFuelOnBoard: Common.interpolate(
                        distanceFromStart,
                        this.checkpoints[i].distanceFromStart,
                        this.checkpoints[i + 1].distanceFromStart,
                        this.checkpoints[i].remainingFuelOnBoard,
                        this.checkpoints[i + 1].remainingFuelOnBoard,
                    ),
                    speed: this.checkpoints[i + 1].speed,
                };
            }
        }

        return {
            distanceFromStart,
            secondsFromPresent: this.lastCheckpoint.secondsFromPresent,
            altitude: this.lastCheckpoint.altitude,
            remainingFuelOnBoard: this.lastCheckpoint.remainingFuelOnBoard,
            speed: this.lastCheckpoint.speed,
        };
    }

    findVerticalCheckpoint(reason: VerticalCheckpointReason): VerticalCheckpoint | undefined {
        return this.checkpoints.find((checkpoint) => checkpoint.reason === reason);
    }

    // TODO: We shouldn't have to go looking for this here...
    // This logic probably belongs to `ClimbPathBuilder`.
    findSpeedLimitCrossing(): [NauticalMiles, Knots] | undefined {
        const speedLimit = this.checkpoints.find((checkpoint) => checkpoint.reason === VerticalCheckpointReason.CrossingSpeedLimit);

        if (!speedLimit) {
            return undefined;
        }

        return [speedLimit.distanceFromStart, speedLimit.speed];
    }

    // TODO: Make this not iterate over map
    findDistancesFromEndToSpeedChanges(): NauticalMiles[] {
        const result: NauticalMiles[] = [];

        const speedLimitCrossing = this.findSpeedLimitCrossing();
        if (!speedLimitCrossing) {
            if (VnavConfig.DEBUG_PROFILE) {
                console.warn('[FMS/VNAV] No speed limit found.');
            }

            return [];
        }

        const [speedLimitDistance, _] = speedLimitCrossing;
        result.push(speedLimitDistance);

        return result;
    }

    addSpeedCheckpoint(distanceFromStart: NauticalMiles, speed: Knots, reason: VerticalCheckpointReason) {
        if (distanceFromStart < this.checkpoints[0].distanceFromStart) {
            this.checkpoints.unshift({ ...this.interpolateEverythingFromStart(distanceFromStart), speed, reason });
            return;
        }

        for (let i = 0; i < this.checkpoints.length - 1; i++) {
            if (distanceFromStart > this.checkpoints[i].distanceFromStart && distanceFromStart <= this.checkpoints[i + 1].distanceFromStart) {
                this.checkpoints.splice(i + 1, 0, { reason, ...this.interpolateEverythingFromStart(distanceFromStart), speed });
                return;
            }
        }

        this.checkpoints.push({ ...this.interpolateEverythingFromStart(distanceFromStart), speed, reason });
    }

    finalizeProfile() {
        this.checkpoints.sort((a, b) => a.distanceFromStart - b.distanceFromStart);

        this.isReadyToDisplay = true;
    }
}
