'use strict';

const { Contract } = require('fabric-contract-api');
const wormhole = require('./wormhole');
const blackhole = require('./blackhole');
const replay = require('./replay');
const poison = require('./poison');

/**
 * SdvNRegistration contract with role-based access control.
 * Roles are conveyed via client identity attributes:
 *  - role: 'trustedAuthority' | 'controller' | 'vehicle'
 *  - vin: VIN value (only for vehicle identities)
 */
class SdvNRegistration extends Contract {
    // ---------- RBAC helpers ----------
    getClientRole(ctx) {
        const role = ctx.clientIdentity.getAttributeValue('role') || '';
        return String(role).toLowerCase();
    }

    requireRole(ctx, allowed) {
        const role = this.getClientRole(ctx);
        const ok = allowed.map((r) => r.toLowerCase()).includes(role);
        if (!ok) {
            throw new Error(
                `Access denied for role '${role}'. Allowed: ${allowed.join(
                    ', '
                )}`
            );
        }
        return role;
    }

    ensureVehicleOwnsVIN(ctx, vin) {
        const role = this.getClientRole(ctx);
        if (role === 'vehicle') {
            const vinAttr = ctx.clientIdentity.getAttributeValue('vin');
            if (!vinAttr || vinAttr !== vin) {
                throw new Error('Vehicle identity can only act on its own VIN');
            }
        }
    }

    // ---------- Deterministic timestamp helper ----------
    // Use the transaction timestamp so all endorsing peers compute identical values
    txNowIso(ctx) {
        const ts = ctx.stub.getTxTimestamp();
        // ts.seconds may be a Long object; normalize to number
        let seconds;
        if (ts && typeof ts.seconds === 'object' && ts.seconds !== null) {
            // protobufjs Long has .low for the lower 32 bits
            seconds =
                typeof ts.seconds.toNumber === 'function'
                    ? ts.seconds.toNumber()
                    : typeof ts.seconds.low === 'number'
                    ? ts.seconds.low
                    : Number(ts.seconds);
        } else {
            seconds = Number(ts && ts.seconds);
        }
        const nanos = ts && typeof ts.nanos === 'number' ? ts.nanos : 0;
        const millis = seconds * 1000 + Math.floor(nanos / 1e6);
        return new Date(millis).toISOString();
    }

    // ---------- Key helpers ----------
    keyForVinAuthority(vin) {
        return `vinreg:${vin}`;
    }
    keyForVehicle(vin) {
        return `vehicle:${vin}`;
    }

    async initLedger(ctx) {
        console.log('SdvNRegistration ledger ready.');
    }

    // ---------- Trusted Authority APIs ----------
    // Store a VIN that is allowed to be registered later by controllers
    async storeVIN(ctx, vin) {
        this.requireRole(ctx, ['trustedAuthority']);
        if (!vin) throw new Error('vin is required');
        const key = this.keyForVinAuthority(vin);
        const exists = await ctx.stub.getState(key);
        if (exists && exists.length) {
            return `VIN ${vin} already stored by trusted authority`;
        }
        const record = {
            vin,
            createdAt: this.txNowIso(ctx),
            issuer: 'trustedAuthority',
        };
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(record)));
        return JSON.stringify(record);
    }

    // Store a contiguous range of numeric VINs (e.g., 1..120)
    // Only trustedAuthority; start and end must be positive integers and start <= end.
    // Skips VINs already present; returns a summary with counts.
    async storeVINRange(ctx, start, end) {
        this.requireRole(ctx, ['trustedAuthority']);
        const s = Number(start);
        const e = Number(end);
        if (!Number.isInteger(s) || !Number.isInteger(e) || s <= 0 || e <= 0) {
            throw new Error('start and end must be positive integers');
        }
        if (s > e) throw new Error('start cannot be greater than end');
        const added = [];
        const skipped = [];
        for (let vinNum = s; vinNum <= e; vinNum++) {
            const vin = String(vinNum);
            const key = this.keyForVinAuthority(vin);
            const exists = await ctx.stub.getState(key);
            if (exists && exists.length) {
                skipped.push(vin);
                continue;
            }
            const record = {
                vin,
                createdAt: this.txNowIso(ctx),
                issuer: 'trustedAuthority',
            };
            await ctx.stub.putState(key, Buffer.from(JSON.stringify(record)));
            added.push(vin);
        }
        return JSON.stringify({
            range: { start: s, end: e },
            totalRequested: e - s + 1,
            addedCount: added.length,
            skippedCount: skipped.length,
            added,
            skipped,
        });
    }

    // ---------- Controller APIs ----------
    // Register a vehicle if VIN exists in authority list
    async registerVehicle(ctx, vin, publicKey, registrationStatus) {
        this.requireRole(ctx, ['controller']);
        if (!vin || !publicKey)
            throw new Error('vin and publicKey are required');
        const authKey = this.keyForVinAuthority(vin);
        const auth = await ctx.stub.getState(authKey);
        if (!auth || !auth.length) {
            throw new Error(
                `Registration denied. VIN ${vin} not found in trusted authority registry`
            );
        }
        const vehKey = this.keyForVehicle(vin);
        const existing = await ctx.stub.getState(vehKey);
        if (existing && existing.length) {
            throw new Error(`Vehicle ${vin} is already registered`);
        }
        const vehicle = {
            VIN: vin,
            publicKey,
            registrationStatus: registrationStatus || 'registered',
            trustedScoreSybil: 100,
            trustedScoreWromehole: 100,
            trustScoreBlackhole: 100,
            trustScorePoison: 100,
            trustScoreReplay: 100,
            neighborArray: [],
            neighborArrayBlackholeVotes: [],
            neighborArrayRoutingData: [],
            locations: [], // ring buffer of up to 20
            createdAt: this.txNowIso(ctx),
        };
        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        return JSON.stringify(vehicle);
    }

    // Get a vehicle with computed overallTrustScore
    async getVehicle(ctx, vin) {
        // controller, trustedAuthority can get any; vehicles can get only their own VIN
        const role = this.getClientRole(ctx);
        if (role === 'vehicle') {
            this.ensureVehicleOwnsVIN(ctx, vin);
        } else {
            this.requireRole(ctx, ['controller', 'trustedAuthority']);
        }
        const vehKey = this.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);
        const vehicle = JSON.parse(data.toString());
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
        return JSON.stringify({
            ...vehicle,
            overallTrustScore: Math.round(overall),
        });
    }

    // Reset all trust-related scores for a vehicle back to 100.
    // Only controller (or trustedAuthority) can perform this reset; vehicles cannot.
    async resetTrustScores(ctx, vin) {
        this.requireRole(ctx, ['controller', 'trustedAuthority']);
        if (!vin) throw new Error('vin is required');
        const vehKey = this.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);
        const vehicle = JSON.parse(data.toString());
        // Reset the underlying scores; overallTrustScore is derived when retrieving via getVehicle.
        vehicle.trustedScoreSybil = 100;
        vehicle.trustedScoreWromehole = 100;
        vehicle.trustScoreBlackhole = 100;
        vehicle.trustScorePoison = 100;
        vehicle.trustScoreReplay = 100;
        // Reset neighbor arrays
        vehicle.neighborArray = [];
        vehicle.neighborArrayBlackholeVotes = [];
        vehicle.neighborArrayRoutingData = [];
        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        // Recompute overall for convenience in the response.
        const scores = [
            vehicle.trustedScoreSybil,
            vehicle.trustedScoreWromehole,
            vehicle.trustScoreBlackhole,
            vehicle.trustScorePoison,
            vehicle.trustScoreReplay,
        ];
        const overall = scores.reduce((a, b) => a + b, 0) / scores.length;
        return JSON.stringify({
            VIN: vin,
            trustedScoreSybil: vehicle.trustedScoreSybil,
            trustedScoreWromehole: vehicle.trustedScoreWromehole,
            trustScoreBlackhole: vehicle.trustScoreBlackhole,
            trustScorePoison: vehicle.trustScorePoison,
            trustScoreReplay: vehicle.trustScoreReplay,
            overallTrustScore: Math.round(overall),
        });
    }

    // ---------- Controller/Vehicle APIs ----------
    // Store a location update; keep only the 20 most recent
    async storeLocation(ctx, vin, latitude, longitude, timestamp) {
        // controller can write any; vehicle can write own VIN only
        const role = this.getClientRole(ctx);
        if (role === 'vehicle') {
            this.ensureVehicleOwnsVIN(ctx, vin);
        } else {
            this.requireRole(ctx, ['controller']);
        }
        const vehKey = this.keyForVehicle(vin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length) throw new Error(`Vehicle ${vin} not found`);
        const vehicle = JSON.parse(data.toString());
        if (!vehicle.locations || !Array.isArray(vehicle.locations))
            vehicle.locations = [];
        const entry = {
            latitude: Number(latitude),
            longitude: Number(longitude),
            timestamp: timestamp || this.txNowIso(ctx),
        };
        vehicle.locations.push(entry);
        if (vehicle.locations.length > 20) {
            vehicle.locations = vehicle.locations.slice(-20);
        }
        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        return JSON.stringify({
            vin,
            count: vehicle.locations.length,
            last: entry,
        });
    }

    // ---------- Admin/Controller: list all stored VINs and registration status ----------
    async listVINStatuses(ctx) {
        // Only controller or trustedAuthority can view the entire list
        this.requireRole(ctx, ['controller', 'trustedAuthority']);

        const results = [];
        // Iterate over keys that start with the vin authority prefix
        const startKey = 'vinreg:';
        // endKey is the next ASCII character after ':' to bound the range
        const endKey = 'vinreg;';
        const iterator = await ctx.stub.getStateByRange(startKey, endKey);
        try {
            // Use explicit next() loop for broad compatibility across Fabric Node shim versions
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const res = await iterator.next();
                if (res.done) break;
                const { key, value } = res.value || {};
                const text = value ? value.toString('utf8') : '';
                let rec = {};
                try {
                    rec = text ? JSON.parse(text) : {};
                } catch (_) {
                    // ignore parse errors and proceed with defaults
                }
                const vin =
                    rec.vin ||
                    (key && key.startsWith(startKey)
                        ? key.slice(startKey.length)
                        : key);
                // Check if a vehicle asset exists for this VIN
                const vehKey = this.keyForVehicle(vin);
                const vehBytes = await ctx.stub.getState(vehKey);
                const registered = !!(vehBytes && vehBytes.length);
                results.push({
                    vin,
                    storedAt: rec.createdAt || null,
                    registered,
                });
            }
        } finally {
            await iterator.close();
        }
        return JSON.stringify(results);
    }

    // ---------- Wormhole-related APIs (delegating to lib/wormhole.js) ----------
    // Role: any vehicle can submit a vote about a VIN
    async storeNeighborVote(
        ctx,
        vin,
        neighborId,
        vote,
        longitude,
        latitude,
        timestamp
    ) {
        return wormhole.storeNeighborVote(
            ctx,
            this,
            vin,
            neighborId,
            vote,
            longitude,
            latitude,
            timestamp
        );
    }

    // Role: only the specific vehicle for VIN can run crossValidation
    async crossValidation(ctx, vin, longitudeV, latitudeV, timestampV) {
        return wormhole.crossValidation(
            ctx,
            this,
            vin,
            longitudeV,
            latitudeV,
            timestampV
        );
    }

    // ---------- V3.0 Wormhole APIs (controller-only simplified voting) ----------
    // Controller: store a simplified vote (vote, timestamp) for a VIN
    async storeNeighborVoteV3(ctx, vin, vote, timestamp) {
        return wormhole.storeNeighborVoteV3(ctx, this, vin, vote, timestamp);
    }

    // Controller: cross-validate using votes from last 10 mins, update overallTrustScore, purge old votes
    async crossValidationV3(ctx, vin) {
        return wormhole.crossValidationV3(ctx, this, vin);
    }

    // ---------- Blackhole-related APIs (delegating to lib/blackhole.js) ----------
    // Vehicle: submit a binary vote (1/0) about a VIN
    async storeBlackholeNeighborVote(ctx, vin, neighborId, vote, timestamp) {
        return blackhole.storeNeighborVoteBlackhole(
            ctx,
            this,
            vin,
            neighborId,
            vote,
            timestamp
        );
    }

    // Controller: reduce trustScoreBlackhole by delta (default 1)
    async reduceBlackholeScore(ctx, vin, delta) {
        return blackhole.reduceTrustScoreBlackhole(ctx, this, vin, delta);
    }

    // Controller: evaluate majority of blackhole votes and penalize if majority is 0
    async evaluateBlackholeVotes(ctx, vin, reduceBy) {
        return blackhole.evaluateBlackholeVotes(ctx, this, vin, reduceBy);
    }

    // ---------- Poison-related APIs (delegating to lib/poison.js) ----------
    // Vehicle: submit a routing-data vote (1/0) about a VIN
    async storePoisonNeighborRoutingVote(
        ctx,
        vin,
        neighborId,
        vote,
        routingData,
        timestamp
    ) {
        return poison.storeNeighborRoutingVote(
            ctx,
            this,
            vin,
            neighborId,
            vote,
            routingData,
            timestamp
        );
    }

    // Vehicle (specific): cross-validate own routing data against neighbor votes
    async crossValidationPoison(ctx, vin, routingDataV, timestampV) {
        return poison.crossValidationPoison(
            ctx,
            this,
            vin,
            routingDataV,
            timestampV
        );
    }

    // ---------- Replay attack mitigation APIs (delegating to lib/replay.js) ----------
    // Vehicle: receiver stores a flowId for the given sender VIN
    async storeFlowIdReplay(ctx, senderVin, flowId, timestamp) {
        return replay.storeFlowIdReplay(
            ctx,
            this,
            senderVin,
            flowId,
            timestamp
        );
    }

    // Vehicle: receiver checks whether the sender already sent the flowId in last 24h
    async checkFlowIdReplay(ctx, senderVin, flowId) {
        return replay.checkFlowIdReplay(ctx, this, senderVin, flowId);
    }
}

module.exports = SdvNRegistration;
// end of file - single contract exported above
