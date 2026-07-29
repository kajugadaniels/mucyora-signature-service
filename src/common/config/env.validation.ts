import { plainToInstance } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsIn,
  Min,
  Max,
  MinLength,
  validateSync,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';

function parseNumberValue(
  value: unknown,
  fallback?: number,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return Number.parseInt(value, 10);
  }

  return Number.NaN;
}

class EnvironmentVariables {
  @IsIn(['development', 'production', 'test'])
  APP_ENV: string;

  @Transform(({ value }) => parseNumberValue(value))
  @IsNumber()
  @Min(1024)
  @Max(65535)
  APP_PORT: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  // Shared with api/auth/ — validates tokens issued there
  @IsString()
  @MinLength(32, {
    message: 'JWT_SECRET must be at least 32 chars and match api/auth/',
  })
  JWT_SECRET: string;

  @IsString()
  @MinLength(32, {
    message: 'ENCRYPTION_SECRET must be at least 32 chars and match api/auth/',
  })
  ENCRYPTION_SECRET: string;

  @IsString()
  @MinLength(32, {
    message:
      'SIGNATURE_ENCRYPTION_SECRET must be at least 32 chars. ' +
      "Generate: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"",
  })
  SIGNATURE_ENCRYPTION_SECRET: string;

  @IsString()
  @IsNotEmpty()
  AWS_REGION: string;

  @IsString()
  @IsNotEmpty()
  AWS_ACCESS_KEY_ID: string;

  @IsString()
  @IsNotEmpty()
  AWS_SECRET_ACCESS_KEY: string;

  @IsString()
  @IsNotEmpty()
  AWS_S3_BUCKET_NAME: string;

  @IsString()
  @IsNotEmpty()
  FRONTEND_URL: string;

  // Optional extra allowed origins for CORS, comma-separated.
  // Used so multiple frontends (user, admin, documents) can call this API.
  @IsOptional()
  @IsString()
  FRONTEND_URLS?: string;

  @IsString()
  @IsNotEmpty()
  SIGNATURE_SERVICE_USERNAME: string;

  @IsString()
  @IsNotEmpty()
  SIGNATURE_SERVICE_PASSWORD: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const messages = errors
      .map((e) => Object.values(e.constraints ?? {}).join(', '))
      .join('\n');
    throw new Error(
      `[Signature Service] Environment validation failed:\n${messages}`,
    );
  }

  return validated;
}
