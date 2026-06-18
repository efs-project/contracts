import { expect } from "chai";
import { getAddress } from "ethers";
import { SCHEMAS, computeSchemaUID } from "../deploy-lib/schemas";

// I-1 (frozen golden vectors). This guards an ETCHED surface: the 9 field strings hash into the
// permanent Sepolia schema UIDs. The verify gate's golden-vector step recomputes UIDs from
// deploy-lib/schemas.ts against itself, which is circular for the 7 schemas whose field strings only
// appear as NatSpec comments in the resolver contracts (ANCHOR/PROPERTY/DATA/PIN/TAG/MIRROR/LIST) —
// a typo in schemas.ts for those would not be caught on-chain. This test breaks that tautology: it
// pins each schema's field string AND its UID (at a FIXED mock resolver address, address(0xEF5)) to
// hardcoded literals. Any future character change to a frozen field string fails CI here.
//
// Does NOT fork: it imports schemas.ts and recomputes off-chain, so it runs in the normal
// `yarn hardhat test` suite. The field strings below are cross-checked byte-for-byte against
// docs/SEPOLIA_FREEZE_TABLE.md — those ARE the freeze-table values.
//
// Regenerating after an INTENTIONAL frozen-set change (rare, Tier-1): set the field string + revocable
// in deploy-lib/schemas.ts, update docs/SEPOLIA_FREEZE_TABLE.md, then recompute the UID with
// computeSchemaUID(fieldString, MOCK_RESOLVER, revocable) and paste it below. The literals are the
// frozen record — do not "fix" a failing literal to match drifted code without a deliberate decision.

// Fixed mock resolver address used ONLY for the UID golden vectors. The real Sepolia UIDs use the
// CREATE3 proxy addresses; this fixed address makes the off-chain vector deterministic and committable.
const MOCK_RESOLVER = getAddress("0x0000000000000000000000000000000000000ef5");

interface GoldenVector {
  name: string;
  fieldString: string;
  revocable: boolean;
  uid: string; // computeSchemaUID(fieldString, MOCK_RESOLVER, revocable)
}

// FROZEN. Order matches docs/SEPOLIA_FREEZE_TABLE.md (1–9).
const GOLDEN: GoldenVector[] = [
  {
    name: "ANCHOR",
    fieldString: "string name, bytes32 forSchema",
    revocable: false,
    uid: "0x393ca282d695bc7da2806f2c4225cd6c00de50c3ffb5ac806728923dfbc2243f",
  },
  {
    name: "PROPERTY",
    fieldString: "string value",
    revocable: false,
    uid: "0xe03f507bf21e4b7b6b5f29addd4f0c3fbb708ca4f700a244f36ed9483aaec689",
  },
  {
    name: "DATA",
    fieldString: "",
    revocable: false,
    uid: "0x87e812753e2fbfc79daa40425af47ad1502e33b3dc953573efd703e333188c3b",
  },
  {
    name: "PIN",
    fieldString: "bytes32 definition",
    revocable: true,
    uid: "0xc7007d54c6fb45f3f45099dcd434906ff4d8606b2d7a5c72798d66c89fa3a11a",
  },
  {
    name: "TAG",
    fieldString: "bytes32 definition, int256 weight",
    revocable: true,
    uid: "0x5ebc9005bd293728f7189e97b4b48108d57ec9e1a2ce4e7a9b11c0a40018c4d3",
  },
  {
    name: "MIRROR",
    fieldString: "bytes32 transportDefinition, string uri",
    revocable: true,
    uid: "0xc856d2dc75d558a46196ba2462cd5a94d350d818c7031bed80dde7cd99b19990",
  },
  {
    name: "LIST",
    fieldString: "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries",
    revocable: false,
    uid: "0x4fc654ae306f2723dd6bc1cd59a81d229e4d06c94cb9db5428d7694415c688f7",
  },
  {
    name: "LIST_ENTRY",
    fieldString: "bytes32 listUID, bytes32 target",
    revocable: true,
    uid: "0xd973a2fad9b5f2494f86abd80dfe174b00f5d26d8185073c6e6ed183b638f833",
  },
  {
    name: "REDIRECT",
    fieldString: "bytes32 target, uint16 kind",
    revocable: true,
    uid: "0xd448aa033fb2d32840169f6a0a8a6bf8d5dcff5a7768b7a7d9fa9b48217342ce",
  },
];

describe("Schema golden vectors (frozen — no fork)", function () {
  it("schemas.ts has exactly the 9 frozen schemas in the freeze-table order", function () {
    expect(SCHEMAS.map(s => s.name)).to.deep.equal(GOLDEN.map(g => g.name));
  });

  for (const g of GOLDEN) {
    describe(g.name, function () {
      const live = SCHEMAS.find(s => s.name === g.name);

      it("field string matches the frozen literal byte-for-byte", function () {
        expect(live, `${g.name} missing from schemas.ts`).to.not.equal(undefined);
        expect(live!.fieldString).to.equal(g.fieldString);
      });

      it("revocable flag matches the frozen literal", function () {
        expect(live!.revocable).to.equal(g.revocable);
      });

      it("computed UID at the fixed mock resolver matches the frozen literal", function () {
        // (a) the literal field string hashes to the frozen UID, and
        // (b) schemas.ts's current field string hashes to the same — so a typo in schemas.ts fails (a)
        //     vs (b) divergence here, not silently against itself.
        expect(computeSchemaUID(g.fieldString, MOCK_RESOLVER, g.revocable)).to.equal(g.uid);
        expect(computeSchemaUID(live!.fieldString, MOCK_RESOLVER, live!.revocable)).to.equal(g.uid);
      });
    });
  }
});
