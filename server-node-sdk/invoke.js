"use strict";

const fs = require("fs");
const path = require("path");
const { Wallets, Gateway } = require("fabric-network");

// Submit a transaction to sdvn chaincode with positional args
async function invokeTransactionArgs(
  fcn,
  argsArray,
  userID,
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
  const identity = await wallet.get(userID);
  if (!identity) {
    return {
      statusCode: 400,
      message: `Identity ${userID} not found in wallet`,
    };
  }

  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity: userID,
    discovery: { enabled: true, asLocalhost: true },
  });
  try {
    const network = await gateway.getNetwork(channelName);
    const contract = network.getContract(chaincodeName);
    const buffer = await contract.submitTransaction(fcn, ...argsArray);
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

module.exports = { invokeTransactionArgs };
