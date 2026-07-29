# api/signature Testing Rules

Add tests when changing:

- private-key encryption/decryption helpers
- certificate request or status logic
- certificate access policy enforcement
- signing proof behavior
- signature-image upload validation

Validation commands:

```bash
npm run build
npm run test
```

Docs-only changes do not require a build.
