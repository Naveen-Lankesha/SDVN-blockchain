'use strict';

const { Contract } = require('fabric-contract-api');

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
}

module.exports = SdvNRegistration;
// end of file - single contract exported above
