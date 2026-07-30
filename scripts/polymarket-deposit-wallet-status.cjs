const fs = require("fs");
const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { polygon } = require("viem/chains");
const { RelayClient } = require("@polymarket/builder-relayer-client");
const { BuilderConfig } = require("@polymarket/builder-signing-sdk");

function loadEnvLocal() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing from .env.local`);
  return value;
}

function maybeEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeAddress(value) {
  return value?.trim().match(/^0x[a-fA-F0-9]{40}/)?.[0];
}

function builderConfig() {
  const key = maybeEnv("BUILDER_API_KEY");
  const secret = maybeEnv("BUILDER_SECRET");
  const passphrase = maybeEnv("BUILDER_PASS_PHRASE", "BUILDER_PASSPHRASE");
  if (key && secret && passphrase) {
    return new BuilderConfig({ localBuilderCreds: { key, secret, passphrase } });
  }
  return undefined;
}

async function main() {
  loadEnvLocal();
  const deploy = process.argv.includes("--deploy");
  const rawKey = requireEnv("POLYMARKET_WALLET_KEY");
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(process.env.POLYGON_RPC_URL || "https://polygon-rpc.com"),
  });
  const relayerUrl = maybeEnv("POLYMARKET_RELAYER_URL", "RELAYER_URL") || "https://relayer-v2.polymarket.com";
  const chainId = Number(maybeEnv("CHAIN_ID") || "137");
  const client = new RelayClient(relayerUrl, chainId, wallet, builderConfig());
  const relayerKey = maybeEnv("RELAYER_API_KEY");
  const relayerKeyAddress = maybeEnv("RELAYER_API_KEY_ADDRESS");
  if (!builderConfig() && relayerKey && relayerKeyAddress) {
    client.sendAuthedRequest = function (method, path, body) {
      return this.send(path, method, {
        headers: {
          RELAYER_API_KEY: relayerKey,
          RELAYER_API_KEY_ADDRESS: relayerKeyAddress,
          "Content-Type": "application/json",
        },
        data: body,
      });
    };
  }

  const derived = await client.deriveDepositWalletAddress();
  const configured = normalizeAddress(maybeEnv("POLYMARKET_DEPOSIT_WALLET", "POLYMARKET_FUNDER"));
  const deployed = await client.getDeployed(configured || derived, "WALLET");
  const hasBuilderCreds = Boolean(builderConfig());
  const hasRelayerKey = Boolean(maybeEnv("RELAYER_API_KEY") && maybeEnv("RELAYER_API_KEY_ADDRESS"));

  const status = {
    owner: account.address,
    relayerUrl,
    chainId,
    derivedDepositWallet: derived,
    configuredDepositWallet: configured || null,
    configuredMatchesDerived: configured ? configured.toLowerCase() === derived.toLowerCase() : null,
    deployed,
    recommendedEnv: {
      POLYMARKET_SIG_TYPE: "3",
      POLYMARKET_FUNDER: derived,
      POLYMARKET_DEPOSIT_WALLET: derived,
      POLYMARKET_WALLET_KEY: "<same owner private key you already set>",
    },
    hasBuilderCreds,
    hasRelayerKey,
    canDeployWithThisScript: hasBuilderCreds || hasRelayerKey,
    deployCommand: "node scripts\\polymarket-deposit-wallet-status.cjs --deploy",
    note: hasBuilderCreds
      ? "Builder credentials are present for authenticated relayer calls."
      : hasRelayerKey
        ? "Relayer API keys are present for authenticated relayer calls."
        : "Authenticated relayer calls need BUILDER_* credentials or RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS.",
  };

  if (!deploy) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (deployed) {
    console.log(JSON.stringify({ ...status, deploySkipped: "deposit wallet is already deployed" }, null, 2));
    return;
  }
  if (!hasBuilderCreds && !hasRelayerKey) {
    throw new Error("Cannot deploy: need BUILDER_* credentials or RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS");
  }
  if (configured && configured.toLowerCase() !== derived.toLowerCase()) {
    throw new Error(`Configured deposit wallet ${configured} does not match derived wallet ${derived} for owner ${account.address}`);
  }

  const response = await client.deployDepositWallet();
  console.log(JSON.stringify({ submitted: true, transactionID: response.transactionID, state: response.state }, null, 2));
  const result = await response.wait();
  console.log(JSON.stringify({ mined: Boolean(result), result }, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
