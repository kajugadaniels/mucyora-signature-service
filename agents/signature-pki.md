# api/signature PKI and Signing Rules

## Key Pairs

- Generate keys server-side.
- Encrypt private keys before storage.
- Do not rotate key encryption behavior without a migration plan.

## Certificates

- Certificate request, certificate issuance, revocation, and access sanctions are separate lifecycle states.
- Admin approval is required before a certificate becomes usable.

## Signing

- Validate active certificate and policy state before signing.
- Keep signing-image display separate from cryptographic proof.
- Signing responses must be safe for server-side proxy consumption from `app/documents`.
