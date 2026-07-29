# MUCYORA Signature Service Security Policy

The Signature Service holds or controls access to private signing material and creates evidence
used during device-ownership transfers. Compromise may permit fraudulent agreements, invalid
ownership changes, privacy exposure, or loss of trust in historical evidence.

## Reporting a Vulnerability

Report vulnerabilities through MUCYORA's private security channel. Do not place the following in a
public issue:

- private or encrypted private keys;
- key-encryption secrets or KMS identifiers tied to production;
- National ID numbers;
- certificates containing personal identifiers;
- signature bytes for live agreements;
- JWTs, service credentials or database URLs;
- private S3 keys or signature images;
- production agreement or ownership-transfer details;
- exploit steps targeting live users.

Preserve evidence, minimize further access, and identify the affected version and operation.

## Security Boundaries

- `api/db` alone owns Prisma schema and migrations.
- `api/auth` owns identity and session state.
- `api/user` owns agreement content, canonicalization, hashes, signature requests and transfers.
- `api/admin` owns administrator authentication and review authorization.
- `api/signature` owns cryptographic keys, certificates, signing and cryptographic verification.
- Browser applications never receive database credentials or private keys.
- A visual signature image is not a cryptographic signature.

## Authoritative Signing Input

The service must not sign an arbitrary hash and name supplied directly by a browser.

A signing operation must reference an existing, authorized `SignatureRequest` containing:

- request ID;
- signer user ID;
- signer role;
- agreement ID;
- immutable agreement-version ID;
- canonical document hash;
- hash algorithm;
- transfer ID;
- expiry;
- status;
- idempotency key;
- requesting service;
- policy version.

The service loads this record from the database or receives it through a strongly authenticated,
integrity-protected internal request and re-validates it before signing.

## Key Protection

### Production target

Prefer:

1. HSM or cloud KMS asymmetric signing where supported; or
2. envelope encryption with KMS and AES-256-GCM; or
3. versioned AES-256-GCM with a protected master key as a temporary stage.

Do not continue unauthenticated AES-CBC storage for production keys.

### Required key metadata

- algorithm;
- provider and key reference;
- encryption format/version;
- wrapping-key version;
- public key;
- fingerprint;
- status;
- created, activated, rotated and revoked timestamps;
- compromise/revocation reason.

Plaintext private keys must never be logged, returned, written to disk, included in exceptions, or
placed in metrics. Minimize time in memory.

## Algorithms

Support only algorithms with complete generation, certificate, signing and verification tests.

Until Ed25519 X.509 issuance and verification are implemented end-to-end, use one approved RSA
profile. Do not expose an algorithm merely because key generation succeeds.

A cryptographic profile must define:

- document canonicalization version;
- document hash algorithm;
- signature algorithm;
- encoding;
- certificate/key reference;
- signed payload structure;
- verification process.

Avoid accidental double hashing. The current behavior of applying `SHA256` signing to already
hashed bytes must be replaced by a documented profile.

## Certificate Privacy

Certificates must not contain raw National ID, passport or other government identity numbers.

Use:

- MUCYORA user UUID or pseudonymous subject ID;
- URI SAN under a MUCYORA-controlled namespace;
- non-sensitive display name only when approved;
- certificate-policy and issuer metadata.

Certificate downloads and public verification responses must be reviewed for data minimization.

## Certificate Trust

Self-signed user certificates do not cryptographically prove MUCYORA administrator approval.

Production choices include:

- a MUCYORA platform CA with issuer keys protected by HSM/KMS;
- managed private PKI;
- a qualified/recognized provider where legal requirements demand it.

The service must report cryptographic validity separately from legal or regulatory status.

## Internal Authentication

HTTP Basic Authentication may exist only during migration.

Production internal calls should use mTLS, workload identity, or signed service requests with:

- caller identity;
- audience;
- scope;
- timestamp;
- nonce;
- body digest;
- signature;
- replay prevention;
- independent rotation.

The authenticated admin identity must come from trusted credentials, not only `adminId` in the
request body.

## Authentication and Authorization

Protected user actions require:

- valid full-session user authentication;
- active account;
- completed identity verification;
- signer identity matching the request;
- certificate-use policy allowed;
- request not expired, completed, cancelled or replayed;
- step-up authentication when policy requires it.

Certificate review and revocation require explicit administrator authorization and audit.

## Rotation and Revocation

Rotation must be atomic from the user's perspective:

1. generate/stage replacement;
2. validate replacement public/private relationship;
3. persist replacement;
4. activate replacement;
5. deactivate old key;
6. revoke linked current certificates;
7. cancel incompatible pending requests;
8. write audit/outbox records.

Failure before activation must not leave the user without a usable key.

Historical signatures continue to verify using their stored certificate even after rotation or
revocation. Current revocation status is reported separately.

## Public Verification

Public verification must be record-centric, rate-limited and privacy-minimized.

Never verify solely by selecting the user's latest unrevoked certificate.

Load:

- stored signature evidence;
- exact certificate ID used at signing;
- exact public key;
- stored agreement hash and profile;
- status at signing;
- current certificate/revocation status.

Do not require the public caller to supply arbitrary user ID, signature and hash combinations.

## Signature Images

Prefer PNG. Reject or safely normalize active formats.

If SVG remains supported:

- parse and sanitize with a security-reviewed library;
- prohibit scripts, event handlers, external references, foreign objects and dangerous data URLs;
- render with restrictive content security;
- apply strict size and complexity limits.

Use private object storage, workload identity, short-lived URLs, and orphan reconciliation.

## Database and Evidence

The Signature Service uses `mucyora_signature_app`.

It must not:

- own tables;
- apply migrations;
- edit generated Prisma files;
- delete historical signing evidence through normal APIs;
- update finalized evidence fields after creation.

Use database constraints for uniqueness, idempotency, one-current-key/certificate rules and
signature-request consistency where practical.

## Logging

Never log:

- plaintext or encrypted private keys;
- key-encryption secrets;
- access tokens;
- full signature values;
- complete document hashes when not operationally necessary;
- raw certificate PEM;
- National IDs;
- full sensitive request bodies;
- database or cloud credentials;
- signature-image bytes or object keys.

Log request IDs, evidence IDs, policy/profile versions, safe reason codes, durations and actor IDs
only where required and authorized.

## Incident Response

For suspected key or signing compromise:

1. isolate affected signing operations;
2. rotate internal and cloud credentials;
3. revoke affected keys/certificates;
4. preserve audit and signing evidence;
5. identify affected signatures and transfers;
6. notify `api/user` and `api/admin` for transfer review/freeze;
7. restore service only after key-boundary validation;
8. communicate cryptographic and current trust status accurately;
9. complete legal/data-protection assessment;
10. add regression tests and preventive controls.

## Recovery

Recovery must preserve:

- database records;
- KMS/HSM key references;
- encryption/wrapping-key versions;
- certificate chain and issuer history;
- signature evidence;
- trust/policy versions;
- visual signature objects where retained.

Losing a master encryption key without a recovery mechanism makes software-encrypted private keys
unusable. Test recovery before production.
