import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CertificateAccessPolicyStatus,
  CertificateRequestStatus,
  PersonalKeyAlgorithm,
  type PersonalCertificateRequest,
} from '@mucyora/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KeysService } from '../keys/keys.service';
import { IssueCertificateDto } from './dto/issue-certificate.dto';
import { RevokeCertificateDto } from './dto/revoke-certificate.dto';
import { decryptIdentityValue } from './helpers/identity-crypto.helper';
import { buildPersonalX509 } from './helpers/x509.helper';

type StoredIdentityRecord = {
  nidEncrypted: string | null;
  surName: string;
  postNames: string;
};

type CertificateRequestRecord = Pick<
  PersonalCertificateRequest,
  | 'id'
  | 'status'
  | 'requestedValidityYears'
  | 'reviewReason'
  | 'cancellationReason'
  | 'reviewedByAdminId'
  | 'reviewedAt'
  | 'cancelledAt'
  | 'issuedCertificateId'
  | 'createdAt'
  | 'updatedAt'
>;

type CertificateAccessPolicyRecord = {
  status: CertificateAccessPolicyStatus;
  banReason: string | null;
  bannedAt: Date | null;
  unbanReason: string | null;
  unbannedAt: Date | null;
  updatedAt: Date;
};

type ActiveKeyPairForRequest = {
  id: string;
  publicKey: string;
  algorithm: PersonalKeyAlgorithm;
};

@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeysService,
    private readonly config: ConfigService,
  ) {}

  async issue(userId: string, dto: IssueCertificateDto) {
    await this.ensureCertificateAccessAllowed(userId, 'request');
    const activeKeyPair = await this.requireActiveKeyPair(userId);
    await this.ensureNoActiveCertificate(userId);
    await this.ensureVerifiedIdentity(userId);
    await this.ensureNoPendingRequest(userId);
    const { keyPair, keyPairRotated } =
      await this.prepareKeyPairForCertificateRequest(userId, activeKeyPair);

    const request = await this.prisma.personalCertificateRequest.create({
      data: {
        userId,
        keyPairId: keyPair.id,
        requestedValidityYears: dto.validityYears ?? 2,
        status: CertificateRequestStatus.PENDING,
      },
      select: this.requestSelect(),
    });

    return {
      ...this.formatRequest(request),
      keyPairRotated,
      message: this.buildCertificateRequestMessage(keyPairRotated),
    };
  }

  async getCurrent(userId: string) {
    const certificate = await this.prisma.personalCertificate.findFirst({
      where: { userId, isRevoked: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!certificate) {
      const latestRequest = await this.findLatestRequest(userId);
      this.throwForMissingCurrentCertificate(latestRequest);
    }

    const now = new Date();
    const expired = certificate.notAfter < now;

    return {
      id: certificate.id,
      serialNumber: certificate.serialNumber,
      subjectCN: certificate.subjectCN,
      notBefore: certificate.notBefore,
      notAfter: certificate.notAfter,
      certificatePem: certificate.certificatePem,
      isRevoked: certificate.isRevoked,
      isExpired: expired,
      daysRemaining: expired
        ? 0
        : Math.floor(
            (certificate.notAfter.getTime() - now.getTime()) / 86_400_000,
          ),
    };
  }

  async getCurrentStatus(userId: string) {
    const now = new Date();
    const [certificate, latestRequest, policy, latestRevocation] =
      await Promise.all([
        this.prisma.personalCertificate.findFirst({
          where: { userId, isRevoked: false },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            serialNumber: true,
            subjectCN: true,
            notBefore: true,
            notAfter: true,
          },
        }),
        this.prisma.personalCertificateRequest.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          select: this.requestSelect(),
        }),
        this.findCertificateAccessPolicy(userId),
        this.prisma.personalCertificate.findFirst({
          where: {
            userId,
            isRevoked: true,
            revokedAt: { not: null },
          },
          orderBy: { revokedAt: 'desc' },
          select: {
            id: true,
            serialNumber: true,
            revokedAt: true,
            revokedReason: true,
          },
        }),
      ]);

    return {
      accessPolicy: this.formatAccessPolicy(policy),
      latestRequest: latestRequest ? this.formatRequest(latestRequest) : null,
      currentCertificate: certificate
        ? this.formatCertificateSummary(certificate, now)
        : null,
      latestRevocation: latestRevocation
        ? {
            certificateId: latestRevocation.id,
            serialNumber: latestRevocation.serialNumber,
            revokedAt: latestRevocation.revokedAt,
            revokedReason: latestRevocation.revokedReason,
          }
        : null,
    };
  }

  async getCurrentRequest(userId: string) {
    const request = await this.prisma.personalCertificateRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: this.requestSelect(),
    });

    if (!request) {
      throw new NotFoundException('No certificate request found.');
    }

    return this.formatRequest(request);
  }

  async revoke(userId: string, dto: RevokeCertificateDto) {
    const certificate = await this.prisma.personalCertificate.findFirst({
      where: { userId, isRevoked: false },
    });

    if (!certificate) {
      throw new NotFoundException('No active certificate to revoke.');
    }

    await this.prisma.personalCertificate.update({
      where: { id: certificate.id },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: dto.reason,
      },
    });

    return {
      message: 'Certificate revoked successfully. This action is permanent.',
      serialNumber: certificate.serialNumber,
      revokedAt: new Date(),
    };
  }

  async approveRequest(
    requestId: string,
    reviewedByAdminId: string,
    reviewReason?: string,
  ) {
    const request = await this.findRequestOrThrow(requestId);

    if (request.status !== CertificateRequestStatus.PENDING) {
      throw new ConflictException(
        'Only pending certificate requests can be approved.',
      );
    }

    if (!request.keyPair.isActive) {
      throw new ConflictException(
        'This certificate request can no longer be approved because its key pair is inactive. Ask the user to submit a new request.',
      );
    }

    await this.ensureRequestApprovalAllowed(request.userId);
    await this.ensureNoActiveCertificate(request.userId);
    await this.ensureKeyPairHasNoCertificate(request.keyPairId);
    const citizenIdentity = await this.ensureVerifiedIdentity(request.userId);
    const subjectIdentity = this.resolveSubjectIdentity(citizenIdentity);

    let privateKeyPem: string | null = await this.keys.decryptActivePrivateKey(
      request.userId,
    );

    const result = buildPersonalX509(
      {
        firstName: citizenIdentity.postNames.split(' ')[0],
        lastName: citizenIdentity.surName,
        userId: request.userId,
        subjectInstId: subjectIdentity.identifier,
      },
      request.keyPair.publicKey,
      privateKeyPem,
      subjectIdentity.subjectCountry,
      request.requestedValidityYears,
    );

    privateKeyPem = null;
    const reviewedAt = new Date();
    const normalizedReason = this.normalizeOptionalReason(reviewReason);

    const certificate = await this.prisma.$transaction(async (tx) => {
      const createdCertificate = await tx.personalCertificate.create({
        data: {
          userId: request.userId,
          keyPairId: request.keyPairId,
          serialNumber: result.serialNumber,
          subjectCN: result.subjectCN,
          subjectO: 'ID Verification Platform',
          subjectC: subjectIdentity.subjectCountry,
          subjectUserId: request.userId,
          notBefore: result.notBefore,
          notAfter: result.notAfter,
          certificatePem: result.certificatePem,
          isRevoked: false,
        },
      });

      await tx.personalCertificateRequest.update({
        where: { id: request.id },
        data: {
          status: CertificateRequestStatus.APPROVED,
          reviewedByAdminId,
          reviewedAt,
          reviewReason: normalizedReason,
          issuedCertificateId: createdCertificate.id,
          cancellationReason: null,
          cancelledAt: null,
        },
      });

      return createdCertificate;
    });

    return {
      id: certificate.id,
      serialNumber: certificate.serialNumber,
      subjectCN: certificate.subjectCN,
      notBefore: certificate.notBefore,
      notAfter: certificate.notAfter,
      certificatePem: certificate.certificatePem,
      isRevoked: certificate.isRevoked,
    };
  }

  async rejectRequest(
    requestId: string,
    reviewedByAdminId: string,
    reviewReason: string,
  ) {
    const request = await this.findRequestOrThrow(requestId);

    if (request.status !== CertificateRequestStatus.PENDING) {
      throw new ConflictException(
        'Only pending certificate requests can be rejected.',
      );
    }

    const normalizedReason = this.requireReason(
      reviewReason,
      'A rejection reason is required.',
    );

    const updatedRequest = await this.prisma.personalCertificateRequest.update({
      where: { id: request.id },
      data: {
        status: CertificateRequestStatus.REJECTED,
        reviewedByAdminId,
        reviewedAt: new Date(),
        reviewReason: normalizedReason,
        cancellationReason: null,
        cancelledAt: null,
      },
      select: this.requestSelect(),
    });

    return this.formatRequest(updatedRequest);
  }

  async cancelPendingRequestsForUser(userId: string, reason: string) {
    const normalizedReason = this.requireReason(
      reason,
      'A cancellation reason is required.',
    );

    await this.prisma.personalCertificateRequest.updateMany({
      where: {
        userId,
        status: CertificateRequestStatus.PENDING,
      },
      data: {
        status: CertificateRequestStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: normalizedReason,
      },
    });
  }

  private async requireActiveKeyPair(userId: string) {
    const keyPair = await this.prisma.personalKeyPair.findFirst({
      where: { userId, isActive: true },
      select: {
        id: true,
        publicKey: true,
        algorithm: true,
      },
    });

    if (!keyPair) {
      throw new BadRequestException(
        'You need an active key pair before requesting a certificate. Call POST /signature/keys/generate first.',
      );
    }

    return keyPair;
  }

  private async ensureNoActiveCertificate(userId: string) {
    const existing = await this.prisma.personalCertificate.findFirst({
      where: { userId, isRevoked: false },
      select: {
        notAfter: true,
      },
    });

    if (existing && existing.notAfter > new Date()) {
      throw new ConflictException(
        'You already have an active certificate. Revoke it first or rotate your keys to replace it.',
      );
    }
  }

  private async prepareKeyPairForCertificateRequest(
    userId: string,
    keyPair: ActiveKeyPairForRequest,
  ) {
    const existing = await this.findCertificateByKeyPair(keyPair.id);

    if (!existing) {
      return { keyPair, keyPairRotated: false };
    }

    const rotatedKeyPair = await this.keys.rotate(userId, {
      algorithm: keyPair.algorithm,
    });

    return {
      keyPair: {
        id: rotatedKeyPair.id,
        publicKey: rotatedKeyPair.publicKey,
        algorithm: rotatedKeyPair.algorithm,
      },
      keyPairRotated: true,
    };
  }

  private async ensureKeyPairHasNoCertificate(keyPairId: string) {
    const existing = await this.findCertificateByKeyPair(keyPairId);

    if (!existing) {
      return;
    }

    throw new ConflictException(
      'This certificate request uses an old key pair that already has a certificate. Ask the user to submit a new request so the platform can rotate their key pair automatically.',
    );
  }

  private async findCertificateByKeyPair(keyPairId: string) {
    const existing = await this.prisma.personalCertificate.findFirst({
      where: { keyPairId },
      select: { id: true },
    });

    return existing;
  }

  private buildCertificateRequestMessage(keyPairRotated: boolean) {
    if (!keyPairRotated) {
      return 'Certificate request submitted successfully. An administrator must approve it before you can sign documents.';
    }

    return (
      'Certificate request submitted successfully. Because your previous ' +
      'certificate was revoked, we automatically rotated your key pair before ' +
      'sending this request for admin approval.'
    );
  }

  private async ensureVerifiedIdentity(userId: string) {
    const citizenIdentity = await this.prisma.citizenIdentity.findUnique({
      where: { userId },
      select: {
        nidEncrypted: true,
        surName: true,
        postNames: true,
      },
    });

    if (!citizenIdentity) {
      throw new BadRequestException(
        'Verified identity data not found. Your account must complete ID verification before a certificate request can be submitted.',
      );
    }

    return citizenIdentity;
  }

  private async ensureNoPendingRequest(userId: string) {
    const pendingRequest = await this.findPendingRequest(userId);

    if (pendingRequest) {
      throw new ConflictException(
        'You already have a certificate request pending admin approval.',
      );
    }
  }

  private async ensureCertificateAccessAllowed(
    userId: string,
    action: 'request' | 'sign',
  ) {
    const policy = await this.findCertificateAccessPolicy(userId);

    if (policy?.status !== CertificateAccessPolicyStatus.BANNED) {
      return;
    }

    throw new ForbiddenException(
      this.buildCertificateAccessBlockedMessage(action, policy.banReason),
    );
  }

  private async ensureRequestApprovalAllowed(userId: string) {
    const policy = await this.findCertificateAccessPolicy(userId);

    if (policy?.status !== CertificateAccessPolicyStatus.BANNED) {
      return;
    }

    const suffix = policy.banReason ? ` Reason: ${policy.banReason}` : '';
    throw new ConflictException(
      `This certificate request cannot be approved because certificate access for this user is currently banned.${suffix}`,
    );
  }

  private async findPendingRequest(userId: string) {
    return this.prisma.personalCertificateRequest.findFirst({
      where: {
        userId,
        status: CertificateRequestStatus.PENDING,
      },
      select: { id: true },
    });
  }

  private findLatestRequest(userId: string) {
    return this.prisma.personalCertificateRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        reviewReason: true,
        cancellationReason: true,
      },
    });
  }

  private findCertificateAccessPolicy(userId: string) {
    return this.prisma.personalCertificateAccessPolicy.findUnique({
      where: { userId },
      select: {
        status: true,
        banReason: true,
        bannedAt: true,
        unbanReason: true,
        unbannedAt: true,
        updatedAt: true,
      },
    });
  }

  private async findRequestOrThrow(requestId: string) {
    const request = await this.prisma.personalCertificateRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        userId: true,
        keyPairId: true,
        status: true,
        requestedValidityYears: true,
        keyPair: {
          select: {
            isActive: true,
            publicKey: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Certificate request not found.');
    }

    return request;
  }

  private requestSelect() {
    return {
      id: true,
      status: true,
      requestedValidityYears: true,
      reviewReason: true,
      cancellationReason: true,
      reviewedByAdminId: true,
      reviewedAt: true,
      cancelledAt: true,
      issuedCertificateId: true,
      createdAt: true,
      updatedAt: true,
    };
  }

  private formatRequest(request: CertificateRequestRecord) {
    return {
      requestId: request.id,
      status: request.status,
      requestedValidityYears: request.requestedValidityYears,
      reviewReason: request.reviewReason,
      cancellationReason: request.cancellationReason,
      reviewedByAdminId: request.reviewedByAdminId,
      reviewedAt: request.reviewedAt,
      cancelledAt: request.cancelledAt,
      issuedCertificateId: request.issuedCertificateId,
      requestedAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  }

  private formatAccessPolicy(policy: CertificateAccessPolicyRecord | null) {
    if (!policy) {
      return {
        status: CertificateAccessPolicyStatus.ALLOWED,
        banReason: null,
        bannedAt: null,
        unbanReason: null,
        unbannedAt: null,
        updatedAt: null,
        isBanned: false,
      };
    }

    return {
      status: policy.status,
      banReason: policy.banReason,
      bannedAt: policy.bannedAt,
      unbanReason: policy.unbanReason,
      unbannedAt: policy.unbannedAt,
      updatedAt: policy.updatedAt,
      isBanned: policy.status === CertificateAccessPolicyStatus.BANNED,
    };
  }

  private formatCertificateSummary(
    certificate: {
      id: string;
      serialNumber: string;
      subjectCN: string;
      notBefore: Date;
      notAfter: Date;
    },
    now: Date,
  ) {
    const isExpired = certificate.notAfter < now;

    return {
      id: certificate.id,
      serialNumber: certificate.serialNumber,
      subjectCN: certificate.subjectCN,
      notBefore: certificate.notBefore,
      notAfter: certificate.notAfter,
      isExpired,
      daysRemaining: isExpired
        ? 0
        : Math.floor(
            (certificate.notAfter.getTime() - now.getTime()) / 86_400_000,
          ),
    };
  }

  private resolveSubjectIdentity(citizenIdentity: StoredIdentityRecord) {
    const nid = this.decryptStoredIdentity(
      citizenIdentity.nidEncrypted,
      'National ID',
    );

    return {
      identifier: nid,
      subjectCountry: 'RW',
    };
  }

  private decryptStoredIdentity(
    encryptedValue: string | null,
    label: string,
  ): string {
    if (!encryptedValue) {
      throw new InternalServerErrorException(
        `Certificate issuance failed: ${label} is missing from the stored identity record.`,
      );
    }

    try {
      const secret = this.config.getOrThrow<string>('ENCRYPTION_SECRET');
      return decryptIdentityValue(encryptedValue, secret);
    } catch {
      throw new InternalServerErrorException(
        `Certificate issuance failed: unable to decrypt stored ${label.toLowerCase()}.`,
      );
    }
  }

  private requireReason(reason: string, message: string) {
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new BadRequestException(message);
    }

    return normalizedReason;
  }

  private normalizeOptionalReason(reason?: string) {
    if (!reason) {
      return null;
    }

    const normalizedReason = reason.trim();
    return normalizedReason || null;
  }

  private buildCertificateAccessBlockedMessage(
    action: 'request' | 'sign',
    banReason: string | null,
  ) {
    const actionText =
      action === 'request'
        ? 'submit a new certificate request'
        : 'sign documents';
    const suffix = banReason ? ` Reason: ${banReason}` : '';

    return `Certificate access has been blocked by platform administrators. You cannot ${actionText} until this restriction is lifted.${suffix}`;
  }

  private throwForMissingCurrentCertificate(
    latestRequest: {
      status: CertificateRequestStatus;
      reviewReason: string | null;
      cancellationReason: string | null;
    } | null,
  ): never {
    if (!latestRequest) {
      throw new NotFoundException(
        'No active certificate found. Submit a certificate request at POST /signature/certificates/issue.',
      );
    }

    if (latestRequest.status === CertificateRequestStatus.PENDING) {
      throw new NotFoundException(
        'No active certificate found. Your certificate request is pending admin approval.',
      );
    }

    if (latestRequest.status === CertificateRequestStatus.REJECTED) {
      const suffix = latestRequest.reviewReason
        ? ` Admin note: ${latestRequest.reviewReason}`
        : '';

      throw new NotFoundException(
        `No active certificate found. Your previous request was rejected and must be resubmitted.${suffix}`,
      );
    }

    if (latestRequest.status === CertificateRequestStatus.CANCELLED) {
      const suffix = latestRequest.cancellationReason
        ? ` Reason: ${latestRequest.cancellationReason}`
        : '';

      throw new NotFoundException(
        `No active certificate found. Your previous request is no longer active.${suffix}`,
      );
    }

    throw new NotFoundException(
      'No active certificate found. Your request was approved, but certificate activation has not completed yet. Refresh and try again shortly.',
    );
  }
}
