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
});
