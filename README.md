# MUCYORA Signature Service

Personal key management, certificate governance, agreement signing, signature verification, and
visual signature-image storage for MUCYORA.

> Repository location: `mucyora/api/signature`  
> Runtime: Node.js 22, NestJS 11 and TypeScript  
> Database package: `@mucyora/db` from `../db`  
> Runtime database role: `mucyora_signature_app`

## Purpose

MUCYORA uses signed agreements to prove that a verified seller and buyer approved one immutable
device-ownership transfer agreement.

The Signature Service provides the cryptographic operations and durable signing evidence for that
workflow. It does not create agreements, calculate ownership, register IMEIs, verify faces, issue
user sessions, or own database migrations.

## MUCYORA Trust Model

The intended workflow is:

1. `api/auth` verifies the user's identity and account state.
2. `api/user` creates an ownership transfer.
3. `api/user` creates and finalizes an agreement version.
4. `api/user` computes the canonical agreement hash server-side.
5. `api/user` creates a signature request for a specific signer and immutable version.
6. The signer explicitly approves the request while authenticated.
7. `api/signature` loads the authoritative request, certificate and exact key.
8. The service signs the immutable agreement hash.
9. It stores cryptographic evidence and returns a constrained result.
10. `api/user` confirms both parties signed the same version and hash before completing transfer.

The service must never treat a browser-supplied hash as authoritative.

## Service Responsibilities

The service owns:

- personal signing-key generation and lifecycle;
- public-key fingerprints;
- protected private-key references or ciphertext;
- key rotation;
- certificate requests and certificate lifecycle;
- administrator approval/rejection bridge;
- certificate access policy enforcement;
- cryptographic signing of approved signature requests;
- verification of stored signing evidence;
- signature history;
- visual signature-image upload, retrieval, replacement and deletion;
- signing-specific audit events and operational telemetry.

The service does not own:

- registration, login, JWT issuance or refresh;
- National ID lookup or biometric verification;
- identity-number decryption;
- user or administrator authentication systems;
- device or IMEI registration;
- ownership-transfer state;
- agreement content, canonicalization or hashing;
- document editing or PDF rendering;
- payment processing;
- the canonical Prisma schema or migrations;
- public legal conclusions about signature enforceability.

## Important Changes From the Existing Project

The current project is a useful starting point, but MUCYORA must change these behaviors:

1. Consume the shared database package as `@mucyora/db` from `file:../db`.
2. Use `mucyora_signature_app` for runtime database access.
3. Remove direct NID decryption from certificate issuance.
4. Do not place raw identity numbers in X.509 certificate subjects.
5. Replace self-signed user certificates with a documented MUCYORA trust profile.
6. Replace AES-256-CBC private-key storage with authenticated encryption or KMS/HSM signing.
7. Make signing request-centric rather than accepting arbitrary hash/name input.
8. Verify using the certificate stored with the signature, not the user's newest certificate.
9. Make key rotation and certificate lifecycle operations atomic and idempotent.
10. Restrict visual signatures to safe raster formats unless SVG is thoroughly sanitized.
11. Replace internal Basic Authentication with signed service identity or mTLS.
12. Add health/readiness routes, Docker packaging, stronger tests and operational recovery.

## Recommended Architecture

```text
mucyora/app/app
        |
        v
mucyora/api/user
        |
        | create/finalize agreement and signature request
        v
mucyora/api/signature
        |
        +--> @mucyora/db
        +--> KMS/HSM or authenticated key-encryption boundary
        +--> private object storage for visual signatures

mucyora/api/admin
        |
        | approve/reject/revoke through authenticated internal API
        v
mucyora/api/signature
```

`api/auth` remains the authority for user identity and sessions. The Signature Service consumes
only the verified user UUID and required status claims or internal evidence references.

## Target Project Structure

```text
mucyora/api/signature/
├── .github/
│   └── workflows/
│       └── api-security.yml
├── docs/
│   ├── INDEX.md
│   ├── agent-guidelines.md
│   ├── architecture-and-boundaries.md
│   ├── api-contracts.md
│   ├── certificate-trust-model.md
│   ├── cryptographic-profile.md
│   ├── database-access.md
│   ├── deployment-and-secrets.md
│   ├── key-lifecycle-and-recovery.md
│   ├── observability-and-audit.md
│   ├── signature-image-security.md
│   ├── signing-workflow.md
│   ├── testing.md
│   ├── threat-model.md
│   └── transformation-roadmap.md
├── scripts/
│   └── assert-project-baseline.mjs
├── src/
│   ├── common/
│   ├── modules/
│   │   ├── auth/
│   │   ├── certificates/
│   │   ├── health/
│   │   ├── keys/
│   │   ├── signature-image/
│   │   └── signing/
│   ├── app.module.ts
│   └── main.ts
├── test/
├── .env.example
├── Dockerfile
├── package.json
├── SECURITY.md
└── README.md
```

All durable guidance lives under `docs/`. The previous `agents/` directory must be removed after
its unique content is consolidated into `docs/agent-guidelines.md`.

## API Direction

### User-facing actions

- retrieve key/certificate readiness;
- create or rotate a key under policy;
- request certificate issuance;
- revoke certificate under approved policy;
- upload/get/delete visual signature;
- approve or reject a pending signature request;
- list own signature history.

### Internal service actions

- admin certificate approval/rejection/revocation;
- user-service signature request creation or confirmation;
- constrained signing operation for an existing signature request.

### Public actions

Public verification should be record-centric:

```text
GET /api/v1/public/signatures/{signatureEvidenceId}
```

The verifier loads the historical proof and the exact certificate used at signing. It should
report:

- cryptographic validity;
- agreement and transfer reference;
- hash algorithm and signing profile;
- certificate status at signing;
- current certificate status;
- signing timestamp;
- constrained signer display information.

It must not expose National ID numbers, private agreement content, email addresses, raw S3 keys,
private keys, or internal risk data.

## Local Development

Expected sibling layout:

```text
mucyora/api/
├── db/
└── signature/
```

Build the database package first:

```bash
cd ../db
npm ci
npm run prisma:generate
npm run build
```

Then prepare the Signature Service:

```bash
cd ../signature
npm ci
cp .env.example .env
npm run build
npm test
npm run start:dev
```

The service must not contain `prisma/schema.prisma`, `prisma/migrations`, or Prisma migration
commands.

## Validation

After applying the migration:

```bash
node scripts/assert-project-baseline.mjs
npm ci
npm run lint
npm run build
npm test
npm run test:e2e
npm run test:cov
npm audit --audit-level=high
```

Run database boundary checks from `api/db`:

```bash
cd ../db
BOUNDARY_CONSUMERS=signature npm run check:boundary
```

## Documentation

Start with [`docs/INDEX.md`](docs/INDEX.md).

## Status

The current implementation is approved as a reusable starting point. Production approval depends
on request-centric signing, historical certificate verification, identity-number removal from
certificates, authenticated private-key protection, atomic lifecycle transitions, and an approved
MUCYORA certificate trust profile.
