import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ThrottlerExceptionFilter } from './common/filters/throttler-exception.filter';
import { buildCorsConfig } from './common/security/cors.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const port = config.get<number>('APP_PORT', 3002);
  const env = config.get<string>('APP_ENV', 'development');

  app.use(helmet());
  app.setGlobalPrefix('api/v1');

  // The signature API is reached from multiple frontend origins (user app,
  // admin app, documents app via proxy). The strict allowlist is composed
  // from FRONTEND_URL plus any comma-separated FRONTEND_URLS entries.
  app.enableCors(
    buildCorsConfig(
      config.get<string>('FRONTEND_URL', 'http://localhost:4000'),
      config.get<string>('FRONTEND_URLS'),
    ),
  );

  app.useGlobalFilters(
    new GlobalExceptionFilter(),
    new ThrottlerExceptionFilter(),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (env !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('MUCYORA 360 — Signature Service')
      .setDescription('Personal digital signature and certificate API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, swaggerConfig),
    );
  }

  await app.listen(port);
  console.log(
    `[${env.toUpperCase()}] Signature service on http://localhost:${port}/api/v1`,
  );
}

void bootstrap();
