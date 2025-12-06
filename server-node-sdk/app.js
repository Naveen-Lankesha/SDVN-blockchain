"use strict";

const express = require("express");
const helper = require("./helper");
const invoke = require("./invoke");
const query = require("./query");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

app.listen(5000, function () {
  console.log("Node SDK server is running on 5000 port :) ");
});

// Health
app.get("/status", (req, res) => res.send("Server is up."));

// Enrollment APIs
app.post("/enrollAdmin", async (req, res, next) => {
  try {
    const { adminWalletName = "org1Admin", orgID = "Org1" } = req.body || {};
    const result = await helper.enrollAdminSimple(adminWalletName, orgID);
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

app.post("/enrollUser", async (req, res, next) => {
  try {
    const { adminId, userId, orgID = "Org1", role, vin } = req.body || {};
    if (!adminId || !userId)
      return res.status(400).send("adminId and userId are required");
    const result = await helper.enrollUserSimple(adminId, userId, orgID, {
      role,
      vin,
    });
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// sdvn-registration chaincode APIs
app.post("/vehicles", async (req, res, next) => {
  try {
    const {
      userId,
      vin,
      publicKey,
      registrationStatus,
      orgID = "Org1",
    } = req.body || {};
    if (!userId || !vin || !publicKey)
      return res.status(400).send("userId, vin, publicKey are required");
    const result = await invoke.invokeTransactionArgs(
      "registerVehicle",
      [vin, publicKey, registrationStatus || "registered"],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Trusted Authority: store VIN in authority list
app.post("/ta/vins", async (req, res, next) => {
  try {
    const { userId, vin, orgID = "Org1" } = req.body || {};
    if (!userId || !vin)
      return res.status(400).send("userId and vin are required");
    const result = await invoke.invokeTransactionArgs(
      "storeVIN",
      [vin],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Trusted Authority: bulk store a contiguous numeric VIN range (e.g. 1..120)
app.post("/ta/vins/range", async (req, res, next) => {
  try {
    const { userId, start, end, orgID = "Org1" } = req.body || {};
    if (!userId || start === undefined || end === undefined) {
      return res.status(400).send("userId, start and end are required in body");
    }
    const s = Number(start);
    const e = Number(end);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s <= 0 || e <= 0) {
      return res.status(400).send("start and end must be positive integers");
    }
    if (s > e) {
      return res.status(400).send("start cannot be greater than end");
    }
    // Optional safeguard: refuse extremely large ranges (>10k) to avoid long endorsement time
    const maxRange = Number(process.env.MAX_VIN_RANGE) || 10000;
    if (e - s + 1 > maxRange) {
      return res
        .status(413)
        .send(
          `Requested range too large (>${maxRange}). Split into smaller batches.`
        );
    }
    const result = await invoke.invokeTransactionArgs(
      "storeVINRange",
      [String(s), String(e)],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Trusted Authority/Controller: list all stored VINs and registration status
app.get("/ta/vins", async (req, res, next) => {
  try {
    const { userId, orgID = "Org1" } = req.query;
    if (!userId)
      return res.status(400).send("userId is required as query param");
    const result = await query.evaluateTransactionArgs(
      "listVINStatuses",
      [],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

app.get("/vehicles/:vin", async (req, res, next) => {
  try {
    const { userId, orgID = "Org1" } = req.query;
    const { vin } = req.params;
    if (!userId)
      return res.status(400).send("userId is required as query param");
    const result = await query.evaluateTransactionArgs(
      "getVehicle",
      [vin],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// (removed) trust-score update endpoint; not part of the new spec

// Controller/Vehicle: store location (keeps last 20)
app.post("/vehicles/:vin/locations", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const {
      userId,
      latitude,
      longitude,
      timestamp,
      orgID = "Org1",
    } = req.body || {};
    if (!userId || latitude === undefined || longitude === undefined) {
      return res.status(400).send("userId, latitude, longitude are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "storeLocation",
      [vin, String(latitude), String(longitude), timestamp || ""],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// (removed) list vehicles endpoint; not required by the new spec

// Wormhole: store neighboring node vote for a vehicle
app.post("/vehicles/:vin/votes", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const {
      userId,
      neighborId,
      vote,
      longitude,
      latitude,
      timestamp,
      orgID = "Org1",
    } = req.body || {};
    if (!userId || !neighborId || vote === undefined || vote === null) {
      return res
        .status(400)
        .send("userId, neighborId and vote (1 or 0) are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "storeNeighborVote",
      [
        vin,
        String(neighborId),
        String(vote),
        String(longitude),
        String(latitude),
        timestamp || "",
      ],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Wormhole: cross validate vehicle-reported location against neighbor votes
app.post("/vehicles/:vin/cross-validate", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const {
      userId,
      longitudeV,
      latitudeV,
      timestampV,
      orgID = "Org1",
    } = req.body || {};
    if (!userId || longitudeV === undefined || latitudeV === undefined) {
      return res
        .status(400)
        .send("userId, longitudeV and latitudeV are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "crossValidation",
      [vin, String(longitudeV), String(latitudeV), timestampV || ""],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ---------- V3.0 Wormhole APIs (controller-only simplified voting) ----------
// Controller: store simplified vote (vote, timestamp) for a VIN
app.post("/vehicles/:vin/votes/v3", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const { userId, vote, timestamp, orgID = "Org1" } = req.body || {};
    if (!userId || vote === undefined || vote === null) {
      return res.status(400).send("userId and vote (1 or 0) are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "storeNeighborVoteV3",
      [vin, String(vote), timestamp || ""],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Controller: cross-validate using last 10 mins votes, update overallTrustScore, purge old votes
app.post("/vehicles/:vin/cross-validate/v3", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const { userId, orgID = "Org1" } = req.body || {};
    if (!userId) {
      return res.status(400).send("userId is required");
    }
    const result = await invoke.invokeTransactionArgs(
      "crossValidationV3",
      [vin],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Controller: manually reduce trustScoreWormhole by delta (default 1)
app.post("/vehicles/:vin/wormhole/reduce", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const { userId, delta, orgID = "Org1" } = req.body || {};
    if (!userId) {
      return res.status(400).send("userId is required");
    }
    const result = await invoke.invokeTransactionArgs(
      "reduceWormholeScore",
      [vin, String(delta ?? "")],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------- Replay attack mitigation APIs ----------------
// Vehicle (receiver): store a flowId in the SENDER's vehicle record
app.post("/vehicles/:senderVin/replay/flow-ids", async (req, res, next) => {
  try {
    const { senderVin } = req.params;
    const { userId, flowId, timestamp, orgID = "Org1" } = req.body || {};
    if (!userId || !flowId) {
      return res.status(400).send("userId and flowId are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "storeFlowIdReplay",
      [senderVin, String(flowId), timestamp || ""],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Vehicle (receiver): check if sender already sent the flowId in last 24 hours (also purges old)
app.post("/vehicles/:senderVin/replay/check", async (req, res, next) => {
  try {
    const { senderVin } = req.params;
    const { userId, flowId, orgID = "Org1" } = req.body || {};
    if (!userId || !flowId) {
      return res.status(400).send("userId and flowId are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "checkFlowIdReplay",
      [senderVin, String(flowId)],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------- Blackhole APIs ----------------
// Vehicle: submit a blackhole vote (1/0) about a VIN
app.post("/vehicles/:vin/blackhole/votes", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const {
      userId,
      neighborId,
      vote,
      timestamp,
      orgID = "Org1",
    } = req.body || {};
    if (!userId || !neighborId || vote === undefined || vote === null) {
      return res
        .status(400)
        .send("userId, neighborId and vote (1 or 0) are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "storeBlackholeNeighborVote",
      [vin, String(neighborId), String(vote), timestamp || ""],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Controller: manually reduce trustScoreBlackhole by delta (default 1)
app.post("/vehicles/:vin/blackhole/reduce", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const { userId, delta, orgID = "Org1" } = req.body || {};
    if (!userId) {
      return res.status(400).send("userId is required");
    }
    const result = await invoke.invokeTransactionArgs(
      "reduceBlackholeScore",
      [vin, String(delta ?? "")],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Controller: evaluate majority of blackhole votes; reduce if majority is 0
app.post("/vehicles/:vin/blackhole/evaluate", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const { userId, reduceBy, orgID = "Org1" } = req.body || {};
    if (!userId) {
      return res.status(400).send("userId is required");
    }
    const result = await invoke.invokeTransactionArgs(
      "evaluateBlackholeVotes",
      [vin, String(reduceBy ?? "")],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Reset trust scores for a vehicle (controller or trustedAuthority role required)
app.post("/vehicles/:vin/trust/reset", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const { userId, orgID = "Org1" } = req.body || {};
    if (!userId) {
      return res.status(400).send("userId is required");
    }
    const result = await invoke.invokeTransactionArgs(
      "resetTrustScores",
      [vin],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------- Poison (routing data) APIs ----------------
// Vehicle: submit a routing-data vote (1/0) about a VIN
app.post("/vehicles/:vin/poison/votes", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const {
      userId,
      neighborId,
      vote,
      routingData,
      timestamp,
      orgID = "Org1",
    } = req.body || {};
    if (!userId || !neighborId || vote === undefined || vote === null) {
      return res
        .status(400)
        .send("userId, neighborId and vote (1 or 0) are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "storePoisonNeighborRoutingVote",
      [
        vin,
        String(neighborId),
        String(vote),
        JSON.stringify(routingData || {}),
        timestamp || "",
      ],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Vehicle (specific): cross-validate own routing data against neighbor votes
app.post("/vehicles/:vin/poison/cross-validate", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const { userId, routingDataV, timestampV, orgID = "Org1" } = req.body || {};
    if (!userId || !routingDataV) {
      return res.status(400).send("userId and routingDataV are required");
    }
    const result = await invoke.invokeTransactionArgs(
      "crossValidationPoison",
      [vin, JSON.stringify(routingDataV || {}), timestampV || ""],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Controller: manually reduce trustScorePoison by delta (default 1)
app.post("/vehicles/:vin/poison/reduce", async (req, res, next) => {
  try {
    const { vin } = req.params;
    const { userId, delta, orgID = "Org1" } = req.body || {};
    if (!userId) {
      return res.status(400).send("userId is required");
    }
    const result = await invoke.invokeTransactionArgs(
      "reducePoisonScore",
      [vin, String(delta ?? "")],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use((err, req, res, next) => {
  res.status(400).send(err.message);
});
