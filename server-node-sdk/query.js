"use strict";

const { Gateway, Wallets } = require("fabric-network");
const path = require("path");
const fs = require("fs");

// Evaluate a transaction on sdvn chaincode with positional args
async function evaluateTransactionArgs(
  fcn,
  argsArray,
  userId,
  orgID = "Org1",
  chaincodeName = "sdvn",
  channelName = "mychannel"
) {
  const ccpPath = path.resolve(
    __dirname,
    "..",
    "fabric-samples",
    "test-network",
    "organizations",
    "peerOrganizations",
    `${orgID}.example.com`.toLowerCase(),
    `connection-${orgID}.json`.toLowerCase()
  );
  const ccp = JSON.parse(fs.readFileSync(ccpPath, "utf8"));

  const walletPath = path.join(process.cwd(), "wallet");
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const identity = await wallet.get(userId);
  if (!identity) {
    return {
      statusCode: 400,
      message: `Identity ${userId} not found in wallet`,
    };
  }

  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity: userId,
    discovery: { enabled: true, asLocalhost: true },
  });
  try {
    const network = await gateway.getNetwork(channelName);
    const contract = network.getContract(chaincodeName);
    const buffer = await contract.evaluateTransaction(fcn, ...argsArray);
    const text = buffer.toString();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    gateway.disconnect();
  }
}

module.exports = { evaluateTransactionArgs };
