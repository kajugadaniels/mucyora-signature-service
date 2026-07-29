import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  CertificateAccessPolicyStatus,
  CertificateRequestStatus,
} from '@mucyora/db';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KeysService } from '../keys/keys.service';
import { SignDocumentDto } from './dto/sign-document.dto';
import { VerifySignatureDto } from './dto/verify-signature.dto';

@Injectable()
export class SigningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeysService,
  ) {}

  async sign(userId: string, dto: SignDocumentDto) {
    // Must have an active, non-expired, non-revoked certificate
    const certificate = await this.getActiveCertificate(userId);

    // Fetch key pair for algorithm info — decryptActivePrivateKey also throws
    // if none exists, so reaching this point guarantees an active key pair
    const keyPair = await this.prisma.personalKeyPair.findFirst({
      where: { userId, isActive: true },
    });

    if (!keyPair) {
      throw new NotFoundException('No active key pair found.');
    }

    // Decrypt private key — used only inside this scope
    let privateKeyPem: string | null =
      await this.keys.decryptActivePrivateKey(userId);

    let signatureBytes: string;

    try {
      const hashBuffer = Buffer.from(dto.documentHash, 'hex');
      const algorithm = keyPair.algorithm === 'ED25519' ? undefined : 'SHA256';

      const sigBuffer = algorithm
        ? crypto.sign(algorithm, hashBuffer, privateKeyPem)
        : crypto.sign(null, hashBuffer, privateKeyPem);

      signatureBytes = sigBuffer.toString('base64');
    } finally {
      // CRITICAL: always discard — even if an error occurs
      privateKeyPem = null;
    }

    // Write immutable audit record
    const record = await this.prisma.personalSignedDocument.create({
      data: {
        userId,
        certificateId: certificate.id,
        documentName: dto.documentName,
        documentHash: dto.documentHash,
        signatureBytes,
      },
    });

    return {
      signatureId: record.id,
      signatureBytes: record.signatureBytes,
      certificateId: record.certificateId,
      documentHash: record.documentHash,
      documentName: record.documentName,
      signedAt: record.signedAt,
    };
  }

  async verify(dto: VerifySignatureDto, ipAddress?: string) {
    const certificate = await this.prisma.personalCertificate.findFirst({
      where: { userId: dto.userId, isRevoked: false },
      orderBy: { createdAt: 'desc' },
    });

    let result = false;
    let failReason: string | undefined;
    let signer:
      | {
          subjectCN: string;
          certificateId: string;
          notBefore: Date;
          notAfter: Date;
        }
      | undefined;

    if (!certificate) {
      result = false;
      failReason = 'No active certificate found for this user.';
    } else if (certificate.notAfter < new Date()) {
      result = false;
      failReason = 'Certificate has expired.';
    } else {
      try {
        const hashBuffer = Buffer.from(dto.documentHash, 'hex');
        const sigBuffer = Buffer.from(dto.signatureBytes, 'base64');

        result = crypto.verify(
          'SHA256',
          hashBuffer,
          certificate.certificatePem,
          sigBuffer,
        );

        if (result) {
          // Certificate is non-null inside this else block — TypeScript knows this
          signer = {
            subjectCN: certificate.subjectCN,
            certificateId: certificate.id,
            notBefore: certificate.notBefore,
            notAfter: certificate.notAfter,
          };
        } else {
          failReason = 'Signature does not match document hash.';
        }
      } catch {
        result = false;
        failReason = 'Signature verification failed — invalid format.';
      }
    }

    // Log every verification — including failed ones
    await this.prisma.personalSignatureVerification.create({
      data: {
        certificateId: certificate?.id ?? null,
        submittedUserId: dto.userId,
        documentHash: dto.documentHash,
        signatureBytes: dto.signatureBytes,
        result,
        failReason,
        ipAddress,
      },
    });

    return {
      valid: result,
      ...(result ? { signer } : { reason: failReason }),
    };
  }

  async getHistory(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const total = await this.prisma.personalSignedDocument.count({
      where: { userId },
    });
    const items = await this.prisma.personalSignedDocument.findMany({
      where: { userId },
      orderBy: { signedAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        documentName: true,
        documentHash: true,
        certificateId: true,
        signedAt: true,
      },
    });

    return { total, page, limit, items };
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async getActiveCertificate(userId: string) {
    const accessPolicy =
      await this.prisma.personalCertificateAccessPolicy.findUnique({
        where: { userId },
        select: {
          status: true,
          banReason: true,
        },
      });

    if (accessPolicy?.status === CertificateAccessPolicyStatus.BANNED) {
      const suffix = accessPolicy.banReason
        ? ` Reason: ${accessPolicy.banReason}`
        : '';
      throw new ForbiddenException(
        `Certificate access has been blocked by platform administrators. You cannot sign documents until this restriction is lifted.${suffix}`,
      );
    }

    const cert = await this.prisma.personalCertificate.findFirst({
      where: { userId, isRevoked: false },
    });

    if (!cert) {
      const latestRequest = await this.prisma.personalCertificateRequest.findFirst({
        where: {
          userId,
        },
        orderBy: { createdAt: 'desc' },
        select: {
          status: true,
          reviewReason: true,
          cancellationReason: true,
        },
      });

      this.throwForMissingCertificate(latestRequest);
    }

    if (cert.notAfter < new Date()) {
      throw new BadRequestException(
        'Your certificate has expired. Please rotate your keys and issue a new certificate.',
      );
    }

    return cert;
  }

  private throwForMissingCertificate(
    latestRequest:
      | {
          status: CertificateRequestStatus;
          reviewReason: string | null;
          cancellationReason: string | null;
        }
      | null,
  ): never {
    if (!latestRequest) {
      throw new BadRequestException(
        'No active certificate. Submit a certificate request at POST /signature/certificates/issue.',
      );
    }

    if (latestRequest.status === CertificateRequestStatus.PENDING) {
      throw new BadRequestException(
        'Your certificate request is pending admin approval. You cannot sign documents until it is approved.',
      );
    }

    if (latestRequest.status === CertificateRequestStatus.REJECTED) {
      const suffix = latestRequest.reviewReason
        ? ` Admin note: ${latestRequest.reviewReason}`
        : '';

      throw new BadRequestException(
        `Your certificate request was rejected. Review the feedback and submit a fresh request before signing.${suffix}`,
      );
    }

    if (latestRequest.status === CertificateRequestStatus.CANCELLED) {
      const suffix = latestRequest.cancellationReason
        ? ` Reason: ${latestRequest.cancellationReason}`
        : '';

      throw new BadRequestException(
        `Your previous certificate request is no longer active. Submit a fresh request with your current key pair before signing.${suffix}`,
      );
    }

    throw new BadRequestException(
      'Your certificate request was approved, but no active certificate is available yet. Refresh and try again shortly. If this persists, contact support.',
    );
  }
}
