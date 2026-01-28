const { ethers } = require("ethers");

const errors = [
    "AccessDenied()",
    "InsufficientValue()",
    "InvalidEAS()",
    "InvalidLength()",
    "NotPayable()",
    "InvalidAttestation()", // EAS error
    "InvalidSchema()", // EAS error
    "AlreadyRevoked()", // EAS error
    "AttestationNotFound()", // EAS error
    "InvalidExpirationTime()", // EAS error
    "InvalidRevocationTime()", // EAS error
    "Irrevocable()", // EAS error
    "NotPayable()", // EAS error
];

errors.forEach(error => {
    const selector = ethers.id(error).slice(0, 10);
    console.log(`${error}: ${selector}`);
});
