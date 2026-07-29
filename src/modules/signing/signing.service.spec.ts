import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CertificateAccessPolicyStatus,
  CertificateRequestStatus,
} from '@mucyora/db';
import { SigningService } from './signing.service';

describe('SigningService', () => {
  function createService() {
    const prisma = {
      personalCertificate: {
        findFirst: jest.fn(),
      },
      personalCertificateAccessPolicy: {
        findUnique: jest.fn(),
      },
      personalCertificateRequest: {
        findFirst: jest.fn(),
      },
      personalKeyPair: {
        findFirst: jest.fn(),
      },
      personalSignedDocument: {
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      personalSignatureVerification: {
        create: jest.fn(),
      },
    };

    const keys = {
      decryptActivePrivateKey: jest.fn(),
    };

    return {
      service: new SigningService(prisma as never, keys as never),
      prisma,
    };
  }

  it('explains pending certificate requests during signing', async () => {
    const { service, prisma } = createService();
    prisma.personalCertificateAccessPolicy.findUnique.mockResolvedValue(null);
    prisma.personalCertificate.findFirst.mockResolvedValue(null);
    prisma.personalCertificateRequest.findFirst.mockResolvedValue({
      status: CertificateRequestStatus.PENDING,
      reviewReason: null,
      cancellationReason: null,
    });

    await expect(
      service.sign('user-1', {
        documentHash: 'a'.repeat(64),
        documentName: 'Contract.pdf',
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Your certificate request is pending admin approval. You cannot sign documents until it is approved.',
      ),
    );
  });

  it('explains rejected certificate requests during signing', async () => {
    const { service, prisma } = createService();
    prisma.personalCertificateAccessPolicy.findUnique.mockResolvedValue(null);
    prisma.personalCertificate.findFirst.mockResolvedValue(null);
    prisma.personalCertificateRequest.findFirst.mockResolvedValue({
      status: CertificateRequestStatus.REJECTED,
      reviewReason: 'Identity evidence must be resubmitted.',
      cancellationReason: null,
    });

    await expect(
      service.sign('user-1', {
        documentHash: 'a'.repeat(64),
        documentName: 'Contract.pdf',
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Your certificate request was rejected. Review the feedback and submit a fresh request before signing. Admin note: Identity evidence must be resubmitted.',
      ),
    );
  });

  it('explains cancelled certificate requests during signing', async () => {
    const { service, prisma } = createService();
    prisma.personalCertificateAccessPolicy.findUnique.mockResolvedValue(null);
    prisma.personalCertificate.findFirst.mockResolvedValue(null);
    prisma.personalCertificateRequest.findFirst.mockResolvedValue({
      status: CertificateRequestStatus.CANCELLED,
      reviewReason: null,
      cancellationReason:
        'Certificate request cancelled automatically because the user rotated their key pair.',
    });

    await expect(
      service.sign('user-1', {
        documentHash: 'a'.repeat(64),
        documentName: 'Contract.pdf',
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Your previous certificate request is no longer active. Submit a fresh request with your current key pair before signing. Reason: Certificate request cancelled automatically because the user rotated their key pair.',
      ),
    );
  });

  it('blocks signing when certificate access is banned', async () => {
    const { service, prisma } = createService();
    prisma.personalCertificateAccessPolicy.findUnique.mockResolvedValue({
      status: CertificateAccessPolicyStatus.BANNED,
      banReason: 'Permanent certificate restriction is active.',
    });

    await expect(
      service.sign('user-1', {
        documentHash: 'a'.repeat(64),
        documentName: 'Contract.pdf',
      }),
    ).rejects.toThrow(
      new ForbiddenException(
        'Certificate access has been blocked by platform administrators. You cannot sign documents until this restriction is lifted. Reason: Permanent certificate restriction is active.',
      ),
    );
  });

  it('records a failed verification when the submitted user has no certificate', async () => {
    const { service, prisma } = createService();
    prisma.personalCertificate.findFirst.mockResolvedValue(null);
    prisma.personalSignatureVerification.create.mockResolvedValue({
      id: 'verification-1',
    });

    const dto = {
      userId: '7d80b7a3-1caf-4e4a-90c1-da69fa157cf8',
      documentHash: 'a'.repeat(64),
      signatureBytes: 'c2lnbmF0dXJl',
    };

    await expect(service.verify(dto, '127.0.0.1')).resolves.toEqual({
      valid: false,
      reason: 'No active certificate found for this user.',
    });

    expect(prisma.personalSignatureVerification.create).toHaveBeenCalledWith({
      data: {
        certificateId: null,
        submittedUserId: dto.userId,
        documentHash: dto.documentHash,
        signatureBytes: dto.signatureBytes,
        result: false,
        failReason: 'No active certificate found for this user.',
        ipAddress: '127.0.0.1',
      },
    });
  });
});
