'use strict';

// Wormhole-related chaincode helpers. These are imported by the main contract
// and executed within the same transaction context (ctx).

// Small tolerance for coordinate comparison (~55 meters for latitude)
const COORD_TOLERANCE_DEG = 0.0005;

function withinTolerance(a, b, tolerance = COORD_TOLERANCE_DEG) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
    return Math.abs(na - nb) <= tolerance;
}

module.exports = {
    /**
     * Store a neighboring node's vote related to a vehicle VIN.
     * Role: vehicle (any vehicle can cast a vote about a VIN)
     * Fields appended to vehicle.neighborArray:
     *  - neighborId
     *  - vote (1 or 0)
     *  - location: { longitude, latitude }
     *  - timestamp (ISO string, uses tx timestamp if not provided)
     */
    async storeNeighborVote(
        ctx,
        helpers,
        vin,
        neighborId,
        vote,
        longitude,
        latitude,
        timestamp
    ) {
        // RBAC: any 'vehicle' identity may submit a vote for any VIN
        helpers.requireRole(ctx, ['vehicle']);

        if (!vin || !neighborId || vote === undefined || vote === null) {
            throw new Error('vin, neighborId and vote are required');
        }
        const v = Number(vote) === 1 ? 1 : 0;

        const vehKey = helpers.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);

        const vehicle = JSON.parse(data.toString());
        if (!Array.isArray(vehicle.neighborArray)) vehicle.neighborArray = [];

        const entry = {
            neighborId: String(neighborId),
            vote: v,
            location: {
                longitude: Number(longitude),
                latitude: Number(latitude),
            },
            timestamp:
                timestamp && String(timestamp).trim()
                    ? String(timestamp)
                    : helpers.txNowIso(ctx),
        };

        vehicle.neighborArray.push(entry);

        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        return JSON.stringify({
            vin,
            lastVote: entry,
            count: vehicle.neighborArray.length,
        });
    },

    /**
     * Cross-validate a vehicle's own reported location using neighbor votes.
     * Role: vehicle (and must be the specific vehicle for VIN)
     * Inputs:
     *  - vin
     *  - longitudeV, latitudeV
     *  - timestampV
     * Logic:
     *  - Consider neighbor votes from the most recent 10 minutes up to timestampV
     *  - If majority of votes are 1: compare one of the voted locations with (longitudeV, latitudeV)
     *      - If roughly matching (within tolerance): no trust change
     *      - Else: reduce trustedScoreWromehole by 1
     *  - If majority of votes are 0: reduce trustedScoreWromehole by 2
     *  - If no votes or no majority: no change
     */
    async crossValidation(
        ctx,
        helpers,
        vin,
        longitudeV,
        latitudeV,
        timestampV
    ) {
        // RBAC: only the vehicle itself can run cross-validation for its own VIN
        helpers.requireRole(ctx, ['vehicle']);
        helpers.ensureVehicleOwnsVIN(ctx, vin);

        if (!vin) throw new Error('vin is required');

        const vehKey = helpers.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);
        const vehicle = JSON.parse(data.toString());

        const reported = {
            longitude: Number(longitudeV),
            latitude: Number(latitudeV),
        };
        const tsStr =
            timestampV && String(timestampV).trim()
                ? String(timestampV)
                : helpers.txNowIso(ctx);
        const tsV = Date.parse(tsStr);
        if (!Number.isFinite(tsV)) throw new Error('timestampV is invalid');

        const windowStart = tsV - 10 * 60 * 1000; // 10 minutes in ms

        const votes = Array.isArray(vehicle.neighborArray)
            ? vehicle.neighborArray
            : [];
        const windowVotes = votes.filter((e) => {
            const t = Date.parse(e && e.timestamp);
            return Number.isFinite(t) && t >= windowStart && t <= tsV;
        });

        if (windowVotes.length === 0) {
            return JSON.stringify({
                vin,
                decision: 'no-votes',
                before: vehicle.trustedScoreWromehole,
                after: vehicle.trustedScoreWromehole,
                delta: 0,
                considered: 0,
            });
        }

        const ones = windowVotes.filter((e) => Number(e.vote) === 1);
        const zeros = windowVotes.filter((e) => Number(e.vote) !== 1);

        let decision = 'no-change';
        let delta = 0;

        if (ones.length > zeros.length) {
            // Majority 1: choose one location to compare
            const loc = (ones[0] && ones[0].location) || {};
            const match =
                withinTolerance(loc.longitude, reported.longitude) &&
                withinTolerance(loc.latitude, reported.latitude);
            if (!match) {
                decision = 'penalized-mismatch';
                delta = -1;
            }
        } else if (zeros.length > ones.length) {
            decision = 'penalized-majority0';
            delta = -2;
        } else {
            // tie -> no change
            decision = 'no-majority';
            delta = 0;
        }

        const before = Number(vehicle.trustedScoreWromehole);
        const after = Math.max(0, before + delta);
        if (delta !== 0) {
            vehicle.trustedScoreWromehole = after;
            await ctx.stub.putState(
                vehKey,
                Buffer.from(JSON.stringify(vehicle))
            );
        }

        return JSON.stringify({
            vin,
            decision,
            before,
            after,
            delta,
            considered: windowVotes.length,
        });
    },

    // ---------- V3.0 Controller-only wormhole functions ----------
    /**
     * Store a simplified neighboring node vote (v3.0).
     * Role: controller only
     * Fields appended to vehicle.neighborArray:
     *  - vote (1 or 0)
     *  - timestamp (ISO string, uses tx timestamp if not provided)
     */
    async storeNeighborVoteV3(ctx, helpers, vin, vote, timestamp) {
        // RBAC: controller only
        helpers.requireRole(ctx, ['controller']);

        if (!vin || vote === undefined || vote === null) {
            throw new Error('vin and vote are required');
        }
        const v = Number(vote) === 1 ? 1 : 0;

        const vehKey = helpers.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);

        const vehicle = JSON.parse(data.toString());
        if (!Array.isArray(vehicle.neighborArray)) vehicle.neighborArray = [];

        const entry = {
            vote: v,
            timestamp:
                timestamp && String(timestamp).trim()
                    ? String(timestamp)
                    : helpers.txNowIso(ctx),
        };

        vehicle.neighborArray.push(entry);

        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        return JSON.stringify({
            vin,
            lastVote: entry,
            count: vehicle.neighborArray.length,
        });
    },

    /**
     * Cross-validate using simplified neighbor votes (v3.0).
     * Role: controller only
     * Logic:
     *  - Consider votes from last 10 minutes
     *  - If majority = 1: no change
     *  - If majority = 0: reduce trustedScoreWromehole by 1
     *  - Update overallTrustScore (average of all 5 trust scores)
     *  - Purge votes older than 1 day (24 hours)
     */
    async crossValidationV3(ctx, helpers, vin) {
        // RBAC: controller only
        helpers.requireRole(ctx, ['controller']);

        if (!vin) throw new Error('vin is required');

        const vehKey = helpers.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);
        const vehicle = JSON.parse(data.toString());

        const now = helpers.txNowIso(ctx);
        const tsNow = Date.parse(now);
        if (!Number.isFinite(tsNow)) throw new Error('Invalid tx timestamp');

        const windowStart = tsNow - 60 * 60 * 1000; // 60 minutes
        const oneDayAgo = tsNow - 24 * 60 * 60 * 1000; // 1 day

        const votes = Array.isArray(vehicle.neighborArray)
            ? vehicle.neighborArray
            : [];

        // Filter votes in 10-min window for evaluation
        const windowVotes = votes.filter((e) => {
            const t = Date.parse(e && e.timestamp);
            return Number.isFinite(t) && t >= windowStart && t <= tsNow;
        });

        let decision = 'no-change';
        let delta = 0;

        if (windowVotes.length > 0) {
            const ones = windowVotes.filter((e) => Number(e.vote) === 1);
            const zeros = windowVotes.filter((e) => Number(e.vote) !== 1);

            if (zeros.length > ones.length) {
                // Majority 0: penalize
                decision = 'penalized-majority0';
                delta = -1;
            } else if (ones.length > zeros.length) {
                // Majority 1: no change
                decision = 'no-penalty-majority1';
                delta = 0;
            } else {
                // Tie: no change
                decision = 'no-majority';
                delta = 0;
            }
        } else {
            decision = 'no-votes';
        }

        const before = Number(vehicle.trustedScoreWromehole);
        const after = Math.max(0, before + delta);
        if (delta !== 0) {
            vehicle.trustedScoreWromehole = after;
        }

        // Update overallTrustScore: average of all 5 trust scores
        const scores = [
            Number(vehicle.trustedScoreSybil),
            Number(vehicle.trustedScoreWromehole),
            Number(vehicle.trustScoreBlackhole),
            Number(vehicle.trustScorePoison),
            Number(vehicle.trustScoreReplay),
        ];
        const valid = scores.filter((n) => Number.isFinite(n));
        const overall = valid.length
            ? valid.reduce((a, b) => a + b, 0) / valid.length
            : 0;
        vehicle.overallTrustScore = Math.round(overall);

        // Purge votes older than 1 day
        const purged = votes.filter((e) => {
            const t = Date.parse(e && e.timestamp);
            return Number.isFinite(t) && t > oneDayAgo;
        });
        const purgeCount = votes.length - purged.length;
        vehicle.neighborArray = purged;

        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));

        return JSON.stringify({
            vin,
            decision,
            before,
            after: vehicle.trustedScoreWromehole,
            delta,
            considered: windowVotes.length,
            overallTrustScore: vehicle.overallTrustScore,
            purgedVotes: purgeCount,
        });
    },
};
