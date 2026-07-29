# api/signature Folder Structure Rules

## Module Ownership

- `keys/` owns personal key-pair generation and encrypted storage.
- `certificates/` owns certificate requests, status, and admin-approved issuance.
- `signature-image/` owns decorative signature-image assets.
- `signing/` owns cryptographic signing and proof persistence.

## Placement Rules

- Put DTOs inside the owning module `dto/`.
- Put crypto helpers beside `keys/` or `certificates/` when they are domain-specific.
- Put S3 and Prisma infrastructure under `src/common/`.
- Do not put document lifecycle logic here; documents belong to `api/documents`.
