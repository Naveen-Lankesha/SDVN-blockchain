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

// Error handler
app.use((err, req, res, next) => {
  res.status(400).send(err.message);
});
