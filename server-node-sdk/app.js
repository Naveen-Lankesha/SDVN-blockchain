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
    const { adminId, userId, orgID = "Org1" } = req.body || {};
    if (!adminId || !userId)
      return res.status(400).send("adminId and userId are required");
    const result = await helper.enrollUserSimple(adminId, userId, orgID);
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// sdvn-registration chaincode APIs
app.post("/vehicles", async (req, res, next) => {
  try {
    const { userId, vin, publicKey, orgID = "Org1" } = req.body || {};
    if (!userId || !vin || !publicKey)
      return res.status(400).send("userId, vin, publicKey are required");
    const result = await invoke.invokeTransactionArgs(
      "registerVehicle",
      [vin, publicKey],
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
      "readVehicle",
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

app.patch("/vehicles/:vin/trust-score", async (req, res, next) => {
  try {
    const { userId, newScore, orgID = "Org1" } = req.body || {};
    const { vin } = req.params;
    if (!userId || newScore === undefined)
      return res.status(400).send("userId and newScore are required");
    const result = await invoke.invokeTransactionArgs(
      "updateTrustScore",
      [vin, String(newScore)],
      userId,
      orgID,
      "sdvn"
    );
    res.status(200).send({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

app.get("/vehicles", async (req, res, next) => {
  try {
    const { userId, orgID = "Org1" } = req.query;
    if (!userId)
      return res.status(400).send("userId is required as query param");
    const result = await query.evaluateTransactionArgs(
      "queryAllVehicles",
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

// Error handler
app.use((err, req, res, next) => {
  res.status(400).send(err.message);
});
