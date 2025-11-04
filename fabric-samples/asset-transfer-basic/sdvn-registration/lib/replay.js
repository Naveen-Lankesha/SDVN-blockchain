'use strict';

// Replay attack mitigation helpers. Imported by the main contract and executed
// within the same transaction context (ctx).

const WINDOW_MS_24H = 24 * 60 * 60 * 1000;

function normalizeTimestamp(strOrIso) {
    const s = String(strOrIso || '').trim();
    return s || null;
}

module.exports = {
    /**
     * Vehicle-only: destination/receiver stores a flowId that was sent by a sender.
     * The flowId is recorded on the SENDER's vehicle record under `flowIdReplay` array
     * with fields: { flowId, timestamp }.
     */
    async storeFlowIdReplay(ctx, helpers, senderVin, flowId, timestamp) {
        // RBAC: any vehicle identity can perform this action
        helpers.requireRole(ctx, ['vehicle']);

        if (!senderVin || !flowId) {
            throw new Error('senderVin and flowId are required');
        }

        const vehKey = helpers.keyForVehicle(senderVin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length)
            throw new Error(`Vehicle ${senderVin} not found`);

        const vehicle = JSON.parse(data.toString());
        if (!Array.isArray(vehicle.flowIdReplay)) vehicle.flowIdReplay = [];

        const tsIso = normalizeTimestamp(timestamp) || helpers.txNowIso(ctx);
        vehicle.flowIdReplay.push({ flowId: String(flowId), timestamp: tsIso });

        await ctx.stub.putState(vehKey, Buffer.from(JSON.stringify(vehicle)));
        return JSON.stringify({
            vin: senderVin,
            stored: { flowId: String(flowId), timestamp: tsIso },
            count: vehicle.flowIdReplay.length,
        });
    },

    /**
     * Vehicle-only: receiver checks whether the sender already sent the given flowId
     * within the last 24 hours. While checking, delete any entries older than 24 hours.
     * Returns { vin, exists, recentCount, purged }.
     */
    async checkFlowIdReplay(ctx, helpers, senderVin, flowId) {
        // RBAC: any vehicle identity can perform this action
        helpers.requireRole(ctx, ['vehicle']);

        if (!senderVin || !flowId) {
            throw new Error('senderVin and flowId are required');
        }

        const vehKey = helpers.keyForVehicle(senderVin);
        const data = await ctx.stub.getState(vehKey);
        if (!data || !data.length)
            throw new Error(`Vehicle ${senderVin} not found`);

        const vehicle = JSON.parse(data.toString());
        const nowIso = helpers.txNowIso(ctx);
        const nowMs = Date.parse(nowIso);
        const cutoff = nowMs - WINDOW_MS_24H;

        const all = Array.isArray(vehicle.flowIdReplay)
            ? vehicle.flowIdReplay
            : [];

        // Partition into recent vs old
        const recent = [];
        let purged = 0;
        for (const e of all) {
            const t = Date.parse(e && e.timestamp);
            if (Number.isFinite(t) && t >= cutoff && t <= nowMs) {
                recent.push(e);
            } else {
                purged += 1;
            }
        }

        // If any were purged, persist the trimmed list
        if (purged > 0) {
            vehicle.flowIdReplay = recent;
            await ctx.stub.putState(
                vehKey,
                Buffer.from(JSON.stringify(vehicle))
            );
        }

        const exists = recent.some((e) => String(e.flowId) === String(flowId));
        return JSON.stringify({
            vin: senderVin,
            exists,
            recentCount: recent.length,
            purged,
            checkedAt: nowIso,
        });
    },
};
