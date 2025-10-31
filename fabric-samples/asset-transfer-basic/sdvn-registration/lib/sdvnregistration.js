'use strict';

const { Contract } = require('fabric-contract-api');

class SdvNRegistration extends Contract {

    async initLedger(ctx) {
        console.log('Ledger initialization complete.');
    }

    // Register vehicle on blockchain
    async registerVehicle(ctx, vin, publicKey) {
        const vehicle = {
            VIN: vin,
            publicKey,
            registered: true,
            trustScore: 100,
        };
        await ctx.stub.putState(vin, Buffer.from(JSON.stringify(vehicle)));
        console.log(`Vehicle ${vin} registered.`);
        return JSON.stringify(vehicle);
    }

    // Read vehicle data
    async readVehicle(ctx, vin) {
        const data = await ctx.stub.getState(vin);
        if (!data || data.length === 0) {
            throw new Error(`Vehicle ${vin} not found`);
        }
        return data.toString();
    }

    // Update trust score
    async updateTrustScore(ctx, vin, newScore) {
        const data = await ctx.stub.getState(vin);
        if (!data || data.length === 0) {
            throw new Error(`Vehicle ${vin} not found`);
        }
        const vehicle = JSON.parse(data.toString());
        vehicle.trustScore = newScore;
        await ctx.stub.putState(vin, Buffer.from(JSON.stringify(vehicle)));
        console.log(`Trust score for ${vin} updated to ${newScore}`);
        return JSON.stringify(vehicle);
    }

    // Query all vehicles
    async queryAllVehicles(ctx) {
        const allResults = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();
        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString()).toString('utf8');
            let record;
            try {
                record = JSON.parse(strValue);
            } catch (err) {
                console.log(err);
                record = strValue;
            }
            allResults.push(record);
            result = await iterator.next();
        }
        return JSON.stringify(allResults);
    }
}

module.exports = SdvNRegistration;
