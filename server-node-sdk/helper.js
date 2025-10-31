"use strict";

const fs = require("fs");
const path = require("path");
const FabricCAServices = require("fabric-ca-client");
const { Wallets } = require("fabric-network");

// Resolve the connection profile for an organization
function getCCP(orgID = "Org1") {
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
  return JSON.parse(fs.readFileSync(ccpPath, "utf8"));
}

// Enroll Org admin using CA bootstrap (admin/adminpw) into the server wallet
async function enrollAdminSimple(
  adminWalletName = "org1Admin",
  orgID = "Org1"
) {
  const ccp = getCCP(orgID);
  const caOrg = ccp.organizations[orgID].certificateAuthorities[0];
  const caInfo = ccp.certificateAuthorities[caOrg];
  const ca = new FabricCAServices(
    caInfo.url,
    { trustedRoots: caInfo.tlsCACerts.pem, verify: false },
    caInfo.caName
  );
  const walletPath = path.join(process.cwd(), "wallet");
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const exists = await wallet.get(adminWalletName);
  if (exists)
    return { statusCode: 200, message: `${adminWalletName} already exists` };
  const enrollment = await ca.enroll({
    enrollmentID: "admin",
    enrollmentSecret: "adminpw",
  });
  const x509Identity = {
    credentials: {
      certificate: enrollment.certificate,
      privateKey: enrollment.key.toBytes(),
    },
    mspId: ccp.organizations[orgID].mspid,
    type: "X.509",
  };
  await wallet.put(adminWalletName, x509Identity);
  return {
    statusCode: 200,
    message: `Enrolled ${orgID} admin as ${adminWalletName}`,
  };
}

// Register and enroll a client identity using an existing admin in wallet
// Options may include attributes such as role and vin
async function enrollUserSimple(adminID, userID, orgID = "Org1", options = {}) {
  const ccp = getCCP(orgID);
  const caOrg = ccp.organizations[orgID].certificateAuthorities[0];
  const caURL = ccp.certificateAuthorities[caOrg].url;
  const ca = new FabricCAServices(caURL);

  const walletPath = path.join(process.cwd(), "wallet");
  const wallet = await Wallets.newFileSystemWallet(walletPath);

  if (await wallet.get(userID)) {
    return { statusCode: 200, message: `${userID} already exists` };
  }
  const adminIdentity = await wallet.get(adminID);
  if (!adminIdentity)
    return { statusCode: 400, message: `Admin ${adminID} not found` };

  const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
  const adminUser = await provider.getUserContext(adminIdentity, adminID);
  // Build attributes (role, vin, plus any other provided)
  const regAttrs = [];
  if (options.role)
    regAttrs.push({ name: "role", value: String(options.role), ecert: true });
  if (options.vin)
    regAttrs.push({ name: "vin", value: String(options.vin), ecert: true });
  if (Array.isArray(options.attrs)) regAttrs.push(...options.attrs);

  let secret;
  try {
    secret = await ca.register(
      {
        affiliation: `${orgID}.department1`.toLowerCase(),
        enrollmentID: userID,
        role: "client",
        attrs: regAttrs,
      },
      adminUser
    );
  } catch (err) {
    // If identity already registered in CA, attempt to reset its secret using IdentityService
    const msg = (err && err.toString && err.toString()) || "";
    if (msg.includes("already registered") || msg.includes("code: 74")) {
      // generate a new secret and update identity on CA
      const idService = ca.newIdentityService();
      const newSecret = `sec-${Math.random().toString(36).slice(2, 10)}`;
      try {
        await idService.update(
          {
            id: userID,
            affiliation: `${orgID}.department1`.toLowerCase(),
            type: "client",
            attrs: regAttrs,
            secret: newSecret,
          },
          adminUser
        );
        secret = newSecret;
      } catch (updateErr) {
        // if update fails, rethrow original registration error for visibility
        throw err;
      }
    } else {
      throw err;
    }
  }

  const enrollment = await ca.enroll({
    enrollmentID: userID,
    enrollmentSecret: secret,
    attr_reqs: regAttrs.map((a) => ({ name: a.name, optional: false })),
  });
  const x509Identity = {
    credentials: {
      certificate: enrollment.certificate,
      privateKey: enrollment.key.toBytes(),
    },
    mspId: ccp.organizations[orgID].mspid,
    type: "X.509",
  };
  await wallet.put(userID, x509Identity);
  return {
    statusCode: 200,
    message: `Enrolled ${userID} for ${orgID}${
      options.role ? " (role=" + options.role + ")" : ""
    }${options.vin ? " (vin=" + options.vin + ")" : ""}`,
  };
}

module.exports = { getCCP, enrollAdminSimple, enrollUserSimple };
