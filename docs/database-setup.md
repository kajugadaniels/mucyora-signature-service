# Database Setup

Use this guide when setting up `api/signature` after cloning the project.

## Ownership

`api/signature` uses the shared MySQL database at runtime, but it does not own
the schema or migrations. Generate the shared Prisma client and apply all
schema migrations from `api/db` only.

## Local XAMPP Connection

Start MySQL in XAMPP and create the local database if it does not exist:

```bash
/Applications/XAMPP/xamppfiles/bin/mysql -u root -e "CREATE DATABASE IF NOT EXISTS mucyora CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

Local development uses the XAMPP `root` account without a password:

```env
DATABASE_URL=mysql://root@127.0.0.1:3306/mucyora
```

Passwordless root access is permitted only on loopback for local development.
Production must use a dedicated `mucyora_signature_app` account with a strong
password, encrypted transport, and only the table privileges documented in
`api/db/docs/runtime-database-roles.md`.

## Prepare The Shared Database Package

From `api/db`, install dependencies, generate the Prisma client, validate the
package, and apply the committed migrations:

```bash
npm install
npm run prisma:generate
npm run check
npm run migrate:deploy
npm run migrate:status
npm run build
```

Migration credentials belong only in `api/db`. Never add
`DATABASE_MIGRATION_URL` to the Signature service.

## Install And Start Signature

From `api/signature`:

```bash
npm install
npm run build
npm run start:dev
```

If startup cannot connect, confirm XAMPP MySQL is listening on
`127.0.0.1:3306`, the `mucyora` database exists, and `DATABASE_URL` uses the
`mysql://` protocol.
