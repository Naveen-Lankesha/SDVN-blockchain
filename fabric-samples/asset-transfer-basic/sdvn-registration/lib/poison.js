'use strict';

// Poison attack mitigation helpers. Imported by the main contract and
// executed within the same transaction context (ctx).

const WINDOW_MS_10MIN = 10 * 60 * 1000;
const WINDOW_MS_24H = 24 * 60 * 60 * 1000;

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

function normalizeIso(ts) {
    const s = String(ts || '').trim();
    return s || null;
}

function parseMaybeJson(objOrStr) {
    if (objOrStr && typeof objOrStr === 'object') return objOrStr;
    const s = String(objOrStr || '').trim();
    if (!s) return {};
    try {
        return JSON.parse(s);
    } catch (_) {
        return {};
    }
}

// Tolerances for matching numeric routing metrics
const TOL_LINK_QUALITY = 0.05; // absolute tolerance
const TOL_LATENCY = 1.0; // milliseconds (or consistent unit)
const TOL_BANDWIDTH = 0.5; // Mbps (or consistent unit)

function approxEqual(a, b, tol) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
    return Math.abs(na - nb) <= tol;
}

function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (String(a[i]) !== String(b[i])) return false;
    }
    return true;
}

function routingDataMatches(a, b) {
    if (!a || !b) return false;
    // Compare core identifiers
    if (String(a.DestinationID) !== String(b.DestinationID)) return false;
    if (String(a.NextHopID) !== String(b.NextHopID)) return false;
    if (!arraysEqual(a.Path, b.Path)) return false;
    if (toNumberOrZero(a.HopCount) !== toNumberOrZero(b.HopCount)) return false;
    // Numeric with tolerance
    if (!approxEqual(a.LinkQuality, b.LinkQuality, TOL_LINK_QUALITY))
        return false;
    if (!approxEqual(a.Latency, b.Latency, TOL_LATENCY)) return false;
    if (!approxEqual(a.Bandwidth, b.Bandwidth, TOL_BANDWIDTH)) return false;
    // Ignore Timestamp field differences; compare Status loosely
    if (a.Status !== undefined || b.Status !== undefined) {
        if (
            String(a.Status || '').toUpperCase() !==
            String(b.Status || '').toUpperCase()
        )
            return false;
    }
    return true;
}

module.exports = {
    /**
     * Vehicle-only: store a neighbor's routing-data vote for a VIN.
     * Appends to vehicle.neighborArrayRoutingData with fields:
     *  - neighborId
     *  - vote (1 or 0)
     *  - routingData: {}
     *  - timestamp (ISO; uses tx time if not provided)
     */
    async storeNeighborRoutingVote(
        ctx,
        helpers,
        vin,
        neighborId,
        vote,
        routingData,
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
        if (!Array.isArray(vehicle.neighborArrayRoutingData)) {
            vehicle.neighborArrayRoutingData = [];
        }

        const entry = {
            neighborId: String(neighborId),
            vote: v,
            routingData: parseMaybeJson(routingData),
            timestamp: normalizeIso(timestamp) || helpers.txNowIso(ctx),
        };

        vehicle.neighborArrayRoutingData.push(entry);

        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        return JSON.stringify({
            vin,
            lastVote: entry,
            count: vehicle.neighborArrayRoutingData.length,
        });
    },

    /**
     * Vehicle-only: cross-validate vehicle's routing data vs neighbor votes.
     * Inputs: vin, routingDataV (object or JSON string), timestampV (ISO)
     * Steps:
     *  - Use timestampV as reference; consider neighbor votes in [timestampV-10min, timestampV]
     *  - During this call, purge neighborArrayRoutingData older than 24h
     *  - If majority votes are 1:
     *      - Compare one of the voted routingData entries with routingDataV (ignore Timestamp, small numeric tolerances)
     *      - If not matching -> reduce trustScorePoison by 1
     *  - If majority votes are 0: reduce trustScorePoison by 2
     *  - Update stored overallTrustScore if trust changed
     */
    async crossValidationPoison(ctx, helpers, vin, routingDataV, timestampV) {
        helpers.requireRole(ctx, ['vehicle']);
        helpers.ensureVehicleOwnsVIN(ctx, vin);

        if (!vin) throw new Error('vin is required');

        const vehKey = helpers.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);
        const vehicle = JSON.parse(data.toString());

        const rdV = parseMaybeJson(routingDataV);
        const tsStr = normalizeIso(timestampV) || helpers.txNowIso(ctx);
        const tRef = Date.parse(tsStr);
        if (!Number.isFinite(tRef)) throw new Error('timestampV is invalid');

        const windowStart = tRef - WINDOW_MS_10MIN;
        const cutoff24h = tRef - WINDOW_MS_24H;

        const allVotes = Array.isArray(vehicle.neighborArrayRoutingData)
            ? vehicle.neighborArrayRoutingData
            : [];

        // Purge >24h old while building recent window
        const recent = [];
        const kept = [];
        for (const e of allVotes) {
            const te = Date.parse(e && e.timestamp);
            if (!Number.isFinite(te)) continue; // skip malformed
            if (te >= cutoff24h) {
                kept.push(e);
                if (te >= windowStart && te <= tRef) recent.push(e);
            }
        }

        // Persist purged list if changed
        if (kept.length !== allVotes.length) {
            vehicle.neighborArrayRoutingData = kept;
            await ctx.stub.putState(
                vehKey,
                Buffer.from(JSON.stringify(vehicle))
            );
        }

        if (recent.length === 0) {
            return JSON.stringify({
                vin,
                decision: 'no-votes',
                considered: 0,
                before: toNumberOrZero(vehicle.trustScorePoison),
                after: toNumberOrZero(vehicle.trustScorePoison),
                delta: 0,
            });
        }

        const ones = recent.filter((e) => Number(e.vote) === 1);
        const zeros = recent.filter((e) => Number(e.vote) !== 1);

        let decision = 'no-change';
        let delta = 0;

        if (ones.length > zeros.length) {
            // Majority 1: compare one voted routingData to provided routingDataV
            const sample = ones.find((e) => e && e.routingData) || ones[0];
            const match = routingDataMatches(sample && sample.routingData, rdV);
            if (!match) {
                decision = 'penalized-mismatch';
                delta = -1;
            } else {
                decision = 'majority1-match-no-penalty';
            }
        } else if (zeros.length > ones.length) {
            decision = 'penalized-majority0';
            delta = -2;
        } else {
            decision = 'no-majority';
        }

        const before = toNumberOrZero(vehicle.trustScorePoison);
        const after = Math.max(0, before + delta);

        if (delta !== 0) {
            vehicle.trustScorePoison = after;
            vehicle.overallTrustScore = computeOverallTrust(vehicle);
            await ctx.stub.putState(
                vehKey,
                Buffer.from(JSON.stringify(vehicle))
            );
        }

        return JSON.stringify({
            vin,
            decision,
            considered: recent.length,
            before,
            after,
            delta,
            overallAfter: vehicle.overallTrustScore,
        });
    },
};
