'use strict';

// Blackhole-related chaincode helpers. Imported by the main contract and
// executed within the same transaction context (ctx).

function toNumberOrZero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function computeOverallTrust(vehicle) {
    const scores = [
        toNumberOrZero(vehicle.trustedScoreSybil),
        toNumberOrZero(vehicle.trustedScoreWromehole),
        toNumberOrZero(vehicle.trustScoreBlackhole),
        toNumberOrZero(vehicle.trustScorePoison),
        toNumberOrZero(vehicle.trustScoreReplay),
    ];
    const valid = scores.filter((n) => Number.isFinite(n));
    const avg = valid.length
        ? valid.reduce((a, b) => a + b, 0) / valid.length
        : 0;
    return Math.round(avg);
}

module.exports = {
    /**
     * Controller-only: reduce trustScoreBlackhole for a VIN by `delta` (default 1).
     * Also updates a persisted `overallTrustScore` field on the vehicle record.
     */
    async reduceTrustScoreBlackhole(ctx, helpers, vin, delta) {
        helpers.requireRole(ctx, ['controller']);
        if (!vin) throw new Error('vin is required');

        const vehKey = helpers.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);
        const vehicle = JSON.parse(data.toString());

        const reduceBy = Math.max(0, Number(delta) || 1);

        const before = toNumberOrZero(vehicle.trustScoreBlackhole);
        const after = Math.max(0, before - reduceBy);
        vehicle.trustScoreBlackhole = after;

        // Maintain a stored overallTrustScore for convenience
        const overallBefore = toNumberOrZero(vehicle.overallTrustScore);
        const overallAfter = computeOverallTrust(vehicle);
        vehicle.overallTrustScore = overallAfter;

        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        return JSON.stringify({
            vin,
            action: 'reduced-blackhole',
            before,
            after,
            delta: -reduceBy,
            overallBefore,
            overallAfter,
        });
    },

    /**
     * Vehicle-only: store a neighbor vote (1 or 0) about a VIN for blackhole analysis.
     * Appends to vehicle.neighborArrayBlackholeVotes with fields:
     *  - neighborId
     *  - vote (1 or 0)
     *  - timestamp (ISO; uses tx time if not provided)
     */
    async storeNeighborVoteBlackhole(
        ctx,
        helpers,
        vin,
        neighborId,
        vote,
        timestamp
    ) {
        helpers.requireRole(ctx, ['vehicle']);

        if (!vin || !neighborId || vote === undefined || vote === null) {
            throw new Error('vin, neighborId and vote are required');
        }

        const v = Number(vote) === 1 ? 1 : 0;
        const vehKey = helpers.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);

        const vehicle = JSON.parse(data.toString());
        if (!Array.isArray(vehicle.neighborArrayBlackholeVotes)) {
            vehicle.neighborArrayBlackholeVotes = [];
        }

        const entry = {
            neighborId: String(neighborId),
            vote: v,
            timestamp:
                timestamp && String(timestamp).trim()
                    ? String(timestamp)
                    : helpers.txNowIso(ctx),
        };

        vehicle.neighborArrayBlackholeVotes.push(entry);

        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        return JSON.stringify({
            vin,
            lastVote: entry,
            count: vehicle.neighborArrayBlackholeVotes.length,
        });
    },

    /**
     * Controller-only: evaluate majority of neighbor votes for blackhole on a VIN.
     * If majority is 1 -> no change. If majority is 0 -> reduce trustScoreBlackhole
     * by `reduceBy` (default 1). Also updates stored overallTrustScore.
     */
    async evaluateBlackholeVotes(ctx, helpers, vin, reduceBy) {
        helpers.requireRole(ctx, ['controller']);
        if (!vin) throw new Error('vin is required');

        const vehKey = helpers.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);
        const vehicle = JSON.parse(data.toString());

        // Consider only votes within the last 10 minutes relative to tx time
        const nowIso = helpers.txNowIso(ctx);
        const nowMs = Date.parse(nowIso);
        const windowStart = nowMs - 10 * 60 * 1000;

        const allVotes = Array.isArray(vehicle.neighborArrayBlackholeVotes)
            ? vehicle.neighborArrayBlackholeVotes
            : [];
        const windowVotes = allVotes.filter((e) => {
            const t = Date.parse(e && e.timestamp);
            return Number.isFinite(t) && t >= windowStart && t <= nowMs;
        });

        if (windowVotes.length === 0) {
            const current = toNumberOrZero(vehicle.trustScoreBlackhole);
            return JSON.stringify({
                vin,
                decision: 'no-votes',
                ones: 0,
                zeros: 0,
                before: current,
                after: current,
                delta: 0,
            });
        }

        const ones = windowVotes.filter((e) => Number(e.vote) === 1).length;
        const zeros = windowVotes.filter((e) => Number(e.vote) !== 1).length;

        let decision = 'no-change';
        let delta = 0;
        const before = toNumberOrZero(vehicle.trustScoreBlackhole);
        let after = before;

        if (zeros > ones) {
            const dec = Math.max(0, Number(reduceBy) || 1);
            after = Math.max(0, before - dec);
            delta = -dec;
            vehicle.trustScoreBlackhole = after;
            decision = 'penalized-majority0';

            // Update overall score when we changed trustScoreBlackhole
            const overallAfter = computeOverallTrust(vehicle);
            vehicle.overallTrustScore = overallAfter;

            await ctx.stub.putState(
                vehKey,
                Buffer.from(JSON.stringify(vehicle))
            );
            return JSON.stringify({
                vin,
                decision,
                ones,
                zeros,
                before,
                after,
                delta,
                overallAfter,
            });
        }

        // No reduction; explicitly report majority outcome
        decision = ones > zeros ? 'majority1-no-penalty' : 'no-majority';
        return JSON.stringify({
            vin,
            decision,
            ones,
            zeros,
            before,
            after,
            delta,
        });
    },
};
