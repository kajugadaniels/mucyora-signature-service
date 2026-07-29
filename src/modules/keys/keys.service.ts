import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { CertificateRequestStatus } from '@mucyora/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GenerateKeyDto } from './dto/generate-key.dto';
import {
  deriveUserKey,
  decryptPrivateKey,
  encryptPrivateKey,
  fingerprintPublicKey,
} from './helpers/key-crypto.helper';

@Injectable()
export class KeysService {
  private readonly logger = new Logger(KeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async generate(userId: string, dto: GenerateKeyDto) {
    const existing = await this.prisma.personalKeyPair.findFirst({
      where: { userId, isActive: true },
    });

    if (existing) {
      throw new ConflictException(
        'You already have an active key pair. Use /keys/rotate to replace it.',
      );
    }

    const { publicKeyPem, privateKeyPem } = await this.generateKeyPair(
      dto.algorithm,
    );

    const masterSecret = this.config.getOrThrow<string>(
      'SIGNATURE_ENCRYPTION_SECRET',
    );
    const derivedKey = deriveUserKey(masterSecret, userId);
    const privateKeyEncrypted = encryptPrivateKey(privateKeyPem, derivedKey);
    const fingerprint = fingerprintPublicKey(publicKeyPem);

    // privateKeyPem is no longer needed — encryption is done
    // JS GC will clean it up; in production HSM this variable would not exist

    const keyPair = await this.prisma.personalKeyPair.create({
      data: {
        userId,
        algorithm: dto.algorithm,
        publicKey: publicKeyPem,
        privateKeyEncrypted,
        fingerprint,
        isActive: true,
      },
    });

    return {
      id: keyPair.id,
      algorithm: keyPair.algorithm,
      publicKey: keyPair.publicKey,
      fingerprint: keyPair.fingerprint,
      createdAt: keyPair.createdAt,
      // Private key NEVER returned
    };
  }

  async getPublicKey(userId: string) {
    const keyPair = await this.prisma.personalKeyPair.findFirst({
      where: { userId, isActive: true },
    });

    if (!keyPair) {
      throw new NotFoundException(
        'No active key pair found. Generate one first at POST /keys/generate.',
      );
    }

    return {
      id: keyPair.id,
      algorithm: keyPair.algorithm,
      publicKey: keyPair.publicKey,
      fingerprint: keyPair.fingerprint,
      createdAt: keyPair.createdAt,
    };
  }

  async rotate(userId: string, dto: GenerateKeyDto) {
    // Mark old key inactive
    await this.prisma.personalKeyPair.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });

    // Revoke any certificate tied to old key pairs
    await this.prisma.personalCertificate.updateMany({
      where: { userId, isRevoked: false },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: 'Key rotation',
      },
    });

    await this.prisma.personalCertificateRequest.updateMany({
      where: {
        userId,
        status: CertificateRequestStatus.PENDING,
      },
      data: {
        status: CertificateRequestStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason:
          'Certificate request cancelled automatically because the user rotated their key pair.',
      },
    });

    // Generate new pair
    return this.generate(userId, dto);
  }

  // ─── Internal helper used by CertificatesService and SigningService ──────────

  async decryptActivePrivateKey(userId: string): Promise<string> {
    const keyPair = await this.prisma.personalKeyPair.findFirst({
      where: { userId, isActive: true },
    });

    if (!keyPair?.privateKeyEncrypted) {
      throw new NotFoundException('No active key pair found.');
    }

    const masterSecret = this.config.getOrThrow<string>(
      'SIGNATURE_ENCRYPTION_SECRET',
    );
    const derivedKey = deriveUserKey(masterSecret, userId);

    return decryptPrivateKey(keyPair.privateKeyEncrypted, derivedKey);
    // CRITICAL: caller must discard this value immediately after use
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async generateKeyPair(algorithm: 'RSA_2048' | 'ED25519') {
    return new Promise<{ publicKeyPem: string; privateKeyPem: string }>(
      (resolve, reject) => {
        if (algorithm === 'RSA_2048') {
          crypto.generateKeyPair(
            'rsa',
            {
              modulusLength: 2048,
              publicKeyEncoding: { type: 'spki', format: 'pem' },
              privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            },
            (err, pub, priv) => {
              if (err) return reject(err);
              resolve({ publicKeyPem: pub, privateKeyPem: priv });
            },
          );
        } else {
          crypto.generateKeyPair(
            'ed25519',
            {
              publicKeyEncoding: { type: 'spki', format: 'pem' },
              privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            },
            (err, pub, priv) => {
              if (err) return reject(err);
              resolve({ publicKeyPem: pub, privateKeyPem: priv });
            },
          );
        }
      },
    );
  }
}
