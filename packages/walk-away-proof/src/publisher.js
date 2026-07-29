import { BrowserProvider, JsonRpcProvider, getAddress } from "ethers";
import {
  CHAIN_HEX,
  CHAIN_ID,
  CONTRACTS,
  DEFAULT_ENDPOINTS,
  EXPECTED_SIGNER,
} from "./constants.js";
import {
  assertExpectedSigner,
  buildStage1,
  buildStage2,
  buildStage3,
  easContract,
  interpretStage1,
  interpretStage2,
  interpretStage3,
  makeProof,
} from "./efs.js";
import {
  manifestDigest,
  recoverManifestSigner,
  typedManifest,
  validateManifest,
} from "./manifest.js";
import "./style.css";

const elements = {
  name: document.querySelector("[data-artifact-name]"),
  sha: document.querySelector("[data-artifact-sha]"),
  size: document.querySelector("[data-artifact-size]"),
  signer: document.querySelector("[data-signer]"),
  contract: document.querySelector("[data-contract]"),
  sourceCommit: document.querySelector("[data-source-commit]"),
  ipfsCid: document.querySelector("[data-ipfs-cid]"),
  arweaveId: document.querySelector("[data-arweave-id]"),
  status: document.querySelector("[data-status]"),
  loadFile: document.querySelector("[data-load-file]"),
  fileInput: document.querySelector("[data-file-input]"),
  connect: document.querySelector("[data-connect]"),
  stage1: document.querySelector("[data-stage1]"),
  stage2: document.querySelector("[data-stage2]"),
  stage3: document.querySelector("[data-stage3]"),
  download: document.querySelector("[data-download]"),
};

let manifest;
let provider;
let signer;
let session = {};
let busy = false;

function short(value) {
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function sessionKey() {
  return `efs-walk-away-proof:${manifestDigest(manifest)}`;
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

function saveSession() {
  localStorage.setItem(sessionKey(), JSON.stringify(session));
}

function stepDone(name, result) {
  const item = document.querySelector(`[data-step="${name}"]`);
  item.classList.toggle("done", Boolean(result));
  const output = document.querySelector(`[data-${name}-result]`);
  if (!output) return;
  const transactionHash = result?.transactionHash;
  output.textContent = transactionHash ? `Confirmed ${short(transactionHash)}` : result ? "Signed" : "";
}

function render() {
  if (!manifest) return;
  elements.name.textContent = manifest.artifactName;
  elements.sha.textContent = `SHA-256 ${manifest.artifactSha256}`;
  elements.size.textContent = `${manifest.artifactByteLength.toLocaleString()} bytes`;
  elements.signer.textContent = manifest.signer;
  elements.contract.textContent = CONTRACTS.eas;
  elements.sourceCommit.textContent = manifest.sourceCommit;
  elements.ipfsCid.textContent = manifest.ipfsCid;
  elements.arweaveId.textContent = manifest.arweaveId;

  stepDone("connect", session.signature);
  stepDone("stage1", session.stage1);
  stepDone("stage2", session.stage2);
  stepDone("stage3", session.stage3);

  elements.connect.disabled = busy || Boolean(session.signature) || Boolean(session.pending);
  elements.stage1.disabled = busy || Boolean(session.pending) || !session.signature || Boolean(session.stage1);
  elements.stage2.disabled = busy || Boolean(session.pending) || !session.stage1 || Boolean(session.stage2);
  elements.stage3.disabled = busy || Boolean(session.pending) || !session.stage2 || Boolean(session.stage3);
  elements.download.disabled = !session.stage3;

  document.querySelectorAll("[data-step]").forEach(item => item.classList.remove("active"));
  const active = !session.signature
    ? "connect"
    : !session.stage1
      ? "stage1"
      : !session.stage2
        ? "stage2"
        : !session.stage3
          ? "stage3"
          : null;
  if (active) document.querySelector(`[data-step="${active}"]`).classList.add("active");

  if (session.stage3) setStatus("Proof complete. Download the signed result.");
  else if (session.pending) {
    setStatus(`Waiting for ${session.pending.stage} confirmation: ${short(session.pending.transactionHash)}`);
  } else if (busy) setStatus("Waiting for MetaMask or transaction confirmation.");
  else setStatus("Ready for the next approval.");
}

async function recoverPending() {
  if (!session.pending) return;
  const { stage, transactionHash } = session.pending;
  const interpretations = {
    stage1: interpretStage1,
    stage2: interpretStage2,
    stage3: interpretStage3,
  };
  try {
    const readProvider = new JsonRpcProvider(DEFAULT_ENDPOINTS.sepoliaRpc, CHAIN_ID, {
      staticNetwork: true,
    });
    const receipt = await readProvider.waitForTransaction(transactionHash, 1, 120_000);
    if (!receipt || receipt.status !== 1) throw new Error(`${stage} transaction failed`);
    session[stage] = interpretations[stage](receipt);
    delete session.pending;
    saveSession();
    render();
  } catch (error) {
    setStatus(`Could not recover pending transaction: ${error.message}`, true);
  }
}

async function setManifest(value) {
  validateManifest(value);
  if (getAddress(value.signer) !== getAddress(EXPECTED_SIGNER)) {
    throw new Error(`Manifest signer must be ${getAddress(EXPECTED_SIGNER)}`);
  }
  manifest = value;
  session = JSON.parse(localStorage.getItem(sessionKey()) || "{}");
  if (session.signature) {
    try {
      const recovered = recoverManifestSigner(manifest, session.signature);
      if (getAddress(recovered) !== getAddress(EXPECTED_SIGNER)) session = {};
    } catch {
      session = {};
    }
  }
  elements.connect.disabled = false;
  render();
  recoverPending();
}

async function connect() {
  if (!window.ethereum) throw new Error("MetaMask was not found in this browser");
  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: CHAIN_HEX }],
  });
  provider = new BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  const address = assertExpectedSigner(await signer.getAddress());
  const typed = typedManifest(manifest);
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
  session = { signature, signer: address };
  saveSession();
}

async function connectedSigner() {
  if (!window.ethereum) throw new Error("MetaMask was not found in this browser");
  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: CHAIN_HEX }],
  });
  provider = new BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  assertExpectedSigner(await signer.getAddress());
  return signer;
}

async function attest(stage, requests, interpret) {
  const activeSigner = await connectedSigner();
  const transaction = await easContract(activeSigner).multiAttest(requests, { value: 0n });
  session.pending = { stage, transactionHash: transaction.hash };
  saveSession();
  setStatus(`Submitted ${short(transaction.hash)}. Waiting for confirmation.`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`Transaction failed: ${transaction.hash}`);
  const result = interpret(receipt);
  delete session.pending;
  return result;
}

async function run(action) {
  if (busy) return;
  busy = true;
  render();
  try {
    await action();
    saveSession();
  } catch (error) {
    setStatus(error.shortMessage || error.message, true);
  } finally {
    busy = false;
    render();
  }
}

elements.connect.addEventListener("click", () =>
  run(async () => {
    await connect();
  }),
);

elements.stage1.addEventListener("click", () =>
  run(async () => {
    session.stage1 = await attest("stage1", buildStage1(manifest), interpretStage1);
  }),
);

elements.stage2.addEventListener("click", () =>
  run(async () => {
    session.stage2 = await attest(
      "stage2",
      buildStage2(manifest, session.signer, session.stage1),
      interpretStage2,
    );
  }),
);

elements.stage3.addEventListener("click", () =>
  run(async () => {
    session.stage3 = await attest(
      "stage3",
      buildStage3(session.stage1, session.stage2),
      interpretStage3,
    );
  }),
);

elements.download.addEventListener("click", () => {
  const proof = makeProof({
    manifest,
    signature: session.signature,
    signer: session.signer,
    stage1: session.stage1,
    stage2: session.stage2,
    stage3: session.stage3,
  });
  const blob = new Blob([`${JSON.stringify(proof, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "proof.json";
  anchor.click();
  URL.revokeObjectURL(url);
});

elements.loadFile.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", async event => {
  try {
    const [file] = event.target.files;
    if (file) await setManifest(JSON.parse(await file.text()));
  } catch (error) {
    setStatus(error.message, true);
  }
});

fetch("/proof/manifest.json")
  .then(response => {
    if (!response.ok) throw new Error("Manifest is not built yet");
    return response.json();
  })
  .then(setManifest)
  .catch(error => {
    setStatus(`${error.message}. Choose a manifest file.`, true);
    elements.loadFile.focus();
  });
