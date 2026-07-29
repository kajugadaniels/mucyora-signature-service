import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CertificateAccessPolicyStatus,
  CertificateRequestStatus,
  IdentityType,
  PersonalKeyAlgorithm,
  type PersonalCertificateRequest,
} from '@mucyora/db';
import { CertificatesService } from './certificates.service';
import { ForeignIdentityClient } from '../foreign-identity/foreign-identity.client';
import { KeysService } from '../keys/keys.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildPersonalX509 } from './helpers/x509.helper';
import { decryptIdentityValue } from './helpers/identity-crypto.helper';

jest.mock('./helpers/x509.helper', () => ({
  buildPersonalX509: jest.fn(),
}));

jest.mock('./helpers/identity-crypto.helper', () => ({
  decryptIdentityValue: jest.fn(),
}));

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

type FindFirstMock<T> = jest.Mock<Promise<T | null>, [unknown?]>;
type FindUniqueMock<T> = jest.Mock<Promise<T | null>, [unknown?]>;
type CreateMock<T> = jest.Mock<Promise<T>, [unknown]>;
type UpdateMock<T> = jest.Mock<Promise<T>, [unknown]>;
type DecryptMock = jest.Mock<Promise<string>, [string]>;
type ConfigGetOrThrowMock = jest.Mock<string, [string]>;
type ForeignLookupMock = jest.Mock<Promise<unknown>, [string]>;
type RotateKeyPairMock = jest.Mock<
  Promise<{
    id: string;
    algorithm: PersonalKeyAlgorithm;
    publicKey: string;
    fingerprint: string;
    createdAt: Date;
  }>,
  [string, { algorithm: PersonalKeyAlgorithm }]
>;

type BuildPersonalX509Mock = jest.MockedFunction<typeof buildPersonalX509>;
type DecryptIdentityValueMock = jest.MockedFunction<
  typeof decryptIdentityValue
>;

const mockBuildPersonalX509 = buildPersonalX509 as BuildPersonalX509Mock;
const mockDecryptIdentityValue =
  decryptIdentityValue as DecryptIdentityValueMock;

const BUILD_RESULT = {
  certificatePem: 'certificate-pem',
  serialNumber: 'SERIAL123',
  notBefore: new Date('2026-04-24T10:00:00.000Z'),
  notAfter: new Date('2028-04-24T10:00:00.000Z'),
  subjectCN: 'Ishimwe Patrick',
};

const PENDING_REQUEST: CertificateRequestRecord = {
  id: 'request-1',
  status: CertificateRequestStatus.PENDING,
  requestedValidityYears: 2,
  reviewReason: null,
  cancellationReason: null,
  reviewedByAdminId: null,
  reviewedAt: null,
  cancelledAt: null,
  issuedCertificateId: null,
  createdAt: new Date('2026-04-27T08:00:00.000Z'),
  updatedAt: new Date('2026-04-27T08:00:00.000Z'),
};

function createService() {
  const personalKeyPairFindFirst = jest.fn<
    ReturnType<
      FindFirstMock<{
        id: string;
        publicKey: string;
        algorithm?: PersonalKeyAlgorithm;
      }>
    >,
    Parameters<
      FindFirstMock<{
        id: string;
        publicKey: string;
        algorithm?: PersonalKeyAlgorithm;
      }>
    >
  >();
  const personalCertificateFindFirst = jest.fn<
    ReturnType<FindFirstMock<{ id?: string; notAfter?: Date }>>,
    Parameters<FindFirstMock<{ id?: string; notAfter?: Date }>>
  >();
  const personalCertificateCreate = jest.fn<
    ReturnType<
      CreateMock<{
        id: string;
        serialNumber: string;
        subjectCN: string;
        notBefore: Date;
        notAfter: Date;
        certificatePem: string;
        isRevoked: boolean;
      }>
    >,
    Parameters<
      CreateMock<{
        id: string;
        serialNumber: string;
        subjectCN: string;
        notBefore: Date;
        notAfter: Date;
        certificatePem: string;
        isRevoked: boolean;
      }>
    >
  >();
  const certificateRequestFindFirst = jest.fn<
    ReturnType<FindFirstMock<{ id: string }>>,
    Parameters<FindFirstMock<{ id: string }>>
  >();
  const certificateRequestCreate = jest.fn<
    ReturnType<CreateMock<CertificateRequestRecord>>,
    Parameters<CreateMock<CertificateRequestRecord>>
  >();
  const certificateRequestFindUnique = jest.fn<
    ReturnType<
      FindUniqueMock<{
        id: string;
        userId: string;
        keyPairId: string;
        status: CertificateRequestStatus;
        requestedValidityYears: number;
        keyPair: { isActive: boolean; publicKey: string };
      }>
    >,
    Parameters<
      FindUniqueMock<{
        id: string;
        userId: string;
        keyPairId: string;
        status: CertificateRequestStatus;
        requestedValidityYears: number;
        keyPair: { isActive: boolean; publicKey: string };
      }>
    >
  >();
  const certificateRequestUpdate = jest.fn<
    ReturnType<UpdateMock<CertificateRequestRecord>>,
    Parameters<UpdateMock<CertificateRequestRecord>>
  >();
  const citizenIdentityFindUnique = jest.fn<
    ReturnType<
      FindUniqueMock<{
        identityType: IdentityType;
        nidEncrypted: string | null;
        finEncrypted: string | null;
        surName: string;
        postNames: string;
      }>
    >,
    Parameters<
      FindUniqueMock<{
        identityType: IdentityType;
        nidEncrypted: string | null;
        finEncrypted: string | null;
        surName: string;
        postNames: string;
      }>
    >
  >();
  const decryptActivePrivateKey = jest.fn<
    ReturnType<DecryptMock>,
    Parameters<DecryptMock>
  >();
  const rotateKeyPair: RotateKeyPairMock = jest.fn();
  const certificateAccessPolicyFindUnique = jest.fn();
  const configGetOrThrow: ConfigGetOrThrowMock = jest.fn((key: string) => {
    if (key === 'ENCRYPTION_SECRET') {
      return 'shared-encryption-secret';
    }

    throw new Error(`Unexpected config key ${key}`);
  });
  const getByFin = jest.fn<
    ReturnType<ForeignLookupMock>,
    Parameters<ForeignLookupMock>
  >();

  const prismaMock = {
    personalKeyPair: {
      findFirst: personalKeyPairFindFirst,
    },
    personalCertificate: {
      findFirst: personalCertificateFindFirst,
      create: personalCertificateCreate,
      update: jest.fn(),
    },
    personalCertificateRequest: {
      findFirst: certificateRequestFindFirst,
      create: certificateRequestCreate,
      findUnique: certificateRequestFindUnique,
      update: certificateRequestUpdate,
      updateMany: jest.fn(),
    },
    personalCertificateAccessPolicy: {
      findUnique: certificateAccessPolicyFindUnique,
    },
    citizenIdentity: {
      findUnique: citizenIdentityFindUnique,
    },
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => {
      return callback(prismaMock);
    }),
  };

  const keysMock = {
    decryptActivePrivateKey,
    rotate: rotateKeyPair,
  };

  const configMock = {
    getOrThrow: configGetOrThrow,
  };

  const foreignIdentityClientMock = {
    getByFin,
  };

  const service = new CertificatesService(
    prismaMock as unknown as PrismaService,
    keysMock as unknown as KeysService,
    configMock as unknown as ConfigService,
    foreignIdentityClientMock as unknown as ForeignIdentityClient,
  );

  return {
    service,
    personalKeyPairFindFirst,
    personalCertificateFindFirst,
    personalCertificateCreate,
    certificateRequestFindFirst,
    certificateRequestCreate,
    certificateRequestFindUnique,
    certificateRequestUpdate,
    citizenIdentityFindUnique,
    decryptActivePrivateKey,
    rotateKeyPair,
    certificateAccessPolicyFindUnique,
    getByFin,
  };
}

describe('CertificatesService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildPersonalX509.mockReturnValue(BUILD_RESULT);
  });

  it('creates a pending certificate request instead of issuing immediately', async () => {
    const {
      service,
      personalKeyPairFindFirst,
      personalCertificateFindFirst,
      certificateRequestFindFirst,
      certificateRequestCreate,
      citizenIdentityFindUnique,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalKeyPairFindFirst.mockResolvedValue({
      id: 'key-1',
      publicKey: 'public-key',
    });
    personalCertificateFindFirst.mockResolvedValue(null);
    certificateRequestFindFirst.mockResolvedValue(null);
    citizenIdentityFindUnique.mockResolvedValue({
      identityType: IdentityType.NID,
      nidEncrypted: 'nid-cipher',
      finEncrypted: null,
      surName: 'Patrick',
      postNames: 'Ishimwe',
    });
    certificateRequestCreate.mockResolvedValue(PENDING_REQUEST);

    const result = await service.issue('user-1', { validityYears: 2 });

    expect(certificateRequestCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        keyPairId: 'key-1',
        requestedValidityYears: 2,
        status: CertificateRequestStatus.PENDING,
      },
      select: expect.any(Object),
    });
    expect(mockBuildPersonalX509).not.toHaveBeenCalled();
    expect(result.status).toBe(CertificateRequestStatus.PENDING);
  });

  it('rejects duplicate pending requests', async () => {
    const {
      service,
      personalKeyPairFindFirst,
      personalCertificateFindFirst,
      certificateRequestFindFirst,
      citizenIdentityFindUnique,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalKeyPairFindFirst.mockResolvedValue({
      id: 'key-1',
      publicKey: 'public-key',
    });
    personalCertificateFindFirst.mockResolvedValue(null);
    citizenIdentityFindUnique.mockResolvedValue({
      identityType: IdentityType.NID,
      nidEncrypted: 'nid-cipher',
      finEncrypted: null,
      surName: 'Patrick',
      postNames: 'Ishimwe',
    });
    certificateRequestFindFirst.mockResolvedValue({ id: 'request-1' });

    await expect(service.issue('user-1', { validityYears: 2 })).rejects.toThrow(
      new ConflictException(
        'You already have a certificate request pending admin approval.',
      ),
    );
  });

  it('automatically rotates reused active key pairs before creating a new request', async () => {
    const {
      service,
      personalKeyPairFindFirst,
      personalCertificateFindFirst,
      certificateRequestFindFirst,
      certificateRequestCreate,
      citizenIdentityFindUnique,
      rotateKeyPair,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalKeyPairFindFirst.mockResolvedValue({
      id: 'key-1',
      publicKey: 'public-key',
      algorithm: PersonalKeyAlgorithm.RSA_2048,
    });
    personalCertificateFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'old-cert-1' });
    citizenIdentityFindUnique.mockResolvedValue({
      identityType: IdentityType.NID,
      nidEncrypted: 'nid-cipher',
      finEncrypted: null,
      surName: 'Patrick',
      postNames: 'Ishimwe',
    });
    certificateRequestFindFirst.mockResolvedValue(null);
    rotateKeyPair.mockResolvedValue({
      id: 'key-2',
      publicKey: 'rotated-public-key',
      algorithm: PersonalKeyAlgorithm.RSA_2048,
      fingerprint: 'rotated-fingerprint',
      createdAt: new Date('2026-04-28T08:00:00.000Z'),
    });
    certificateRequestCreate.mockResolvedValue(PENDING_REQUEST);

    const result = await service.issue('user-1', { validityYears: 2 });

    expect(rotateKeyPair).toHaveBeenCalledWith('user-1', {
      algorithm: PersonalKeyAlgorithm.RSA_2048,
    });
    expect(certificateRequestCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        keyPairId: 'key-2',
        requestedValidityYears: 2,
        status: CertificateRequestStatus.PENDING,
      },
      select: expect.any(Object),
    });
    expect(result.keyPairRotated).toBe(true);
    expect(result.message).toContain('automatically rotated your key pair');
  });

  it('approves a NID-backed request and issues a real certificate', async () => {
    const {
      service,
      personalCertificateFindFirst,
      personalCertificateCreate,
      certificateRequestFindUnique,
      certificateRequestUpdate,
      citizenIdentityFindUnique,
      decryptActivePrivateKey,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalCertificateFindFirst.mockResolvedValue(null);
    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });
    citizenIdentityFindUnique.mockResolvedValue({
      identityType: IdentityType.NID,
      nidEncrypted: 'nid-cipher',
      finEncrypted: null,
      surName: 'Patrick',
      postNames: 'Ishimwe',
    });
    decryptActivePrivateKey.mockResolvedValue('private-key');
    mockDecryptIdentityValue.mockReturnValue('1199912345678901');
    personalCertificateCreate.mockResolvedValue({
      id: 'cert-1',
      serialNumber: BUILD_RESULT.serialNumber,
      subjectCN: BUILD_RESULT.subjectCN,
      notBefore: BUILD_RESULT.notBefore,
      notAfter: BUILD_RESULT.notAfter,
      certificatePem: BUILD_RESULT.certificatePem,
      isRevoked: false,
    });
    certificateRequestUpdate.mockResolvedValue({
      ...PENDING_REQUEST,
      status: CertificateRequestStatus.APPROVED,
      issuedCertificateId: 'cert-1',
    });

    const result = await service.approveRequest('request-1', 'admin-1');

    expect(mockBuildPersonalX509).toHaveBeenCalledWith(
      {
        firstName: 'Ishimwe',
        lastName: 'Patrick',
        userId: 'user-1',
        subjectInstId: '1199912345678901',
      },
      'public-key',
      'private-key',
      'RW',
      2,
    );
    expect(certificateRequestUpdate).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({
        status: CertificateRequestStatus.APPROVED,
        reviewedByAdminId: 'admin-1',
        issuedCertificateId: 'cert-1',
      }),
    });
    expect(result.id).toBe('cert-1');
  });

  it('rejects approval when the request key pair already has a certificate', async () => {
    const {
      service,
      personalCertificateFindFirst,
      certificateRequestFindUnique,
      personalCertificateCreate,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalCertificateFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'old-cert-1' });
    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });

    await expect(
      service.approveRequest('request-1', 'admin-1'),
    ).rejects.toThrow(
      new ConflictException(
        'This certificate request uses an old key pair that already has a certificate. Ask the user to submit a new request so the platform can rotate their key pair automatically.',
      ),
    );
    expect(personalCertificateCreate).not.toHaveBeenCalled();
  });

  it('approves a FIN-backed request with the foreign country and FIN subject identifier', async () => {
    const {
      service,
      personalCertificateFindFirst,
      personalCertificateCreate,
      certificateRequestFindUnique,
      certificateRequestUpdate,
      citizenIdentityFindUnique,
      decryptActivePrivateKey,
      getByFin,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalCertificateFindFirst.mockResolvedValue(null);
    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });
    citizenIdentityFindUnique.mockResolvedValue({
      identityType: IdentityType.FIN,
      nidEncrypted: null,
      finEncrypted: 'fin-cipher',
      surName: 'Patrick',
      postNames: 'Ishimwe',
    });
    decryptActivePrivateKey.mockResolvedValue('private-key');
    mockDecryptIdentityValue.mockReturnValue('2199180000001234');
    getByFin.mockResolvedValue({
      fin: '2199180000001234',
      firstName: 'Ishimwe',
      lastName: 'Patrick',
      gender: 'MALE',
      dateOfBirth: '1991-04-15',
      countryOfOrigin: 'KE',
      nationality: 'Kenyan',
      maritalStatus: 'SINGLE',
      issuanceVersion: 0,
      isActive: true,
    });
    personalCertificateCreate.mockResolvedValue({
      id: 'cert-1',
      serialNumber: BUILD_RESULT.serialNumber,
      subjectCN: BUILD_RESULT.subjectCN,
      notBefore: BUILD_RESULT.notBefore,
      notAfter: BUILD_RESULT.notAfter,
      certificatePem: BUILD_RESULT.certificatePem,
      isRevoked: false,
    });
    certificateRequestUpdate.mockResolvedValue({
      ...PENDING_REQUEST,
      status: CertificateRequestStatus.APPROVED,
      issuedCertificateId: 'cert-1',
    });

    await service.approveRequest('request-1', 'admin-1');

    expect(getByFin).toHaveBeenCalledWith('2199180000001234');
    expect(mockBuildPersonalX509).toHaveBeenCalledWith(
      {
        firstName: 'Ishimwe',
        lastName: 'Patrick',
        userId: 'user-1',
        subjectInstId: '2199180000001234',
      },
      'public-key',
      'private-key',
      'KE',
      2,
    );
  });

  it('maps foreign identity unavailability to ServiceUnavailableException during approval', async () => {
    const {
      service,
      personalCertificateFindFirst,
      certificateRequestFindUnique,
      citizenIdentityFindUnique,
      decryptActivePrivateKey,
      getByFin,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalCertificateFindFirst.mockResolvedValue(null);
    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });
    citizenIdentityFindUnique.mockResolvedValue({
      identityType: IdentityType.FIN,
      nidEncrypted: null,
      finEncrypted: 'fin-cipher',
      surName: 'Patrick',
      postNames: 'Ishimwe',
    });
    decryptActivePrivateKey.mockResolvedValue('private-key');
    mockDecryptIdentityValue.mockReturnValue('2199180000001234');
    getByFin.mockRejectedValue(new ServiceUnavailableException('down'));

    await expect(
      service.approveRequest('request-1', 'admin-1'),
    ).rejects.toThrow(
      new ServiceUnavailableException(
        'Foreign identity service is currently unavailable. Please try again in a few minutes.',
      ),
    );
  });

  it('maps missing FIN registry entries to InternalServerErrorException during approval', async () => {
    const {
      service,
      personalCertificateFindFirst,
      certificateRequestFindUnique,
      citizenIdentityFindUnique,
      decryptActivePrivateKey,
      getByFin,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalCertificateFindFirst.mockResolvedValue(null);
    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });
    citizenIdentityFindUnique.mockResolvedValue({
      identityType: IdentityType.FIN,
      nidEncrypted: null,
      finEncrypted: 'fin-cipher',
      surName: 'Patrick',
      postNames: 'Ishimwe',
    });
    decryptActivePrivateKey.mockResolvedValue('private-key');
    mockDecryptIdentityValue.mockReturnValue('2199180000001234');
    getByFin.mockRejectedValue(new NotFoundException());

    await expect(
      service.approveRequest('request-1', 'admin-1'),
    ).rejects.toThrow(
      new InternalServerErrorException(
        'Certificate issuance failed: associated foreign identity record not found. Contact platform administrators.',
      ),
    );
  });

  it('rejects a pending request with an admin reason', async () => {
    const {
      service,
      certificateRequestFindUnique,
      certificateRequestUpdate,
    } = createService();

    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });
    certificateRequestUpdate.mockResolvedValue({
      ...PENDING_REQUEST,
      status: CertificateRequestStatus.REJECTED,
      reviewReason: 'Identity review needs manual correction.',
      reviewedByAdminId: 'admin-1',
      reviewedAt: new Date('2026-04-27T09:00:00.000Z'),
    });

    const result = await service.rejectRequest(
      'request-1',
      'admin-1',
      'Identity review needs manual correction.',
    );

    expect(result.status).toBe(CertificateRequestStatus.REJECTED);
    expect(result.reviewReason).toBe(
      'Identity review needs manual correction.',
    );
  });

  it('requires a reason when rejecting a request', async () => {
    const { service, certificateRequestFindUnique } = createService();

    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });

    await expect(service.rejectRequest('request-1', 'admin-1', '   ')).rejects.toThrow(
      new BadRequestException('A rejection reason is required.'),
    );
  });

  it('maps foreign identity auth failures to ServiceUnavailableException during approval', async () => {
    const {
      service,
      personalCertificateFindFirst,
      certificateRequestFindUnique,
      citizenIdentityFindUnique,
      decryptActivePrivateKey,
      getByFin,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue(null);
    personalCertificateFindFirst.mockResolvedValue(null);
    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });
    citizenIdentityFindUnique.mockResolvedValue({
      identityType: IdentityType.FIN,
      nidEncrypted: null,
      finEncrypted: 'fin-cipher',
      surName: 'Patrick',
      postNames: 'Ishimwe',
    });
    decryptActivePrivateKey.mockResolvedValue('private-key');
    mockDecryptIdentityValue.mockReturnValue('2199180000001234');
    getByFin.mockRejectedValue(
      new UnauthorizedException('invalid service credentials'),
    );

    await expect(
      service.approveRequest('request-1', 'admin-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns a rejected-state certificate lookup message when the latest request was rejected', async () => {
    const {
      service,
      personalCertificateFindFirst,
      certificateRequestFindFirst,
    } = createService();

    personalCertificateFindFirst.mockResolvedValue(null);
    certificateRequestFindFirst.mockResolvedValue({
      status: CertificateRequestStatus.REJECTED,
      reviewReason: 'Photo identity evidence did not match the verified profile.',
      cancellationReason: null,
    });

    await expect(service.getCurrent('user-1')).rejects.toThrow(
      new NotFoundException(
        'No active certificate found. Your previous request was rejected and must be resubmitted. Admin note: Photo identity evidence did not match the verified profile.',
      ),
    );
  });

  it('returns an approved-state certificate lookup message when issuance has not activated yet', async () => {
    const {
      service,
      personalCertificateFindFirst,
      certificateRequestFindFirst,
    } = createService();

    personalCertificateFindFirst.mockResolvedValue(null);
    certificateRequestFindFirst.mockResolvedValue({
      status: CertificateRequestStatus.APPROVED,
      reviewReason: 'Approved.',
      cancellationReason: null,
    });

    await expect(service.getCurrent('user-1')).rejects.toThrow(
      new NotFoundException(
        'No active certificate found. Your request was approved, but certificate activation has not completed yet. Refresh and try again shortly.',
      ),
    );
  });

  it('blocks certificate requests while certificate access is banned', async () => {
    const {
      service,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateAccessPolicyFindUnique.mockResolvedValue({
      status: CertificateAccessPolicyStatus.BANNED,
      banReason: 'Repeated trust-chain violations require manual review.',
      bannedAt: new Date('2026-04-28T09:30:00.000Z'),
      unbanReason: null,
      unbannedAt: null,
      updatedAt: new Date('2026-04-28T09:30:00.000Z'),
    });

    await expect(service.issue('user-1', { validityYears: 2 })).rejects.toThrow(
      new ForbiddenException(
        'Certificate access has been blocked by platform administrators. You cannot submit a new certificate request until this restriction is lifted. Reason: Repeated trust-chain violations require manual review.',
      ),
    );
  });

  it('blocks approval when certificate access is currently banned', async () => {
    const {
      service,
      certificateRequestFindUnique,
      certificateAccessPolicyFindUnique,
    } = createService();

    certificateRequestFindUnique.mockResolvedValue({
      id: 'request-1',
      userId: 'user-1',
      keyPairId: 'key-1',
      status: CertificateRequestStatus.PENDING,
      requestedValidityYears: 2,
      keyPair: {
        isActive: true,
        publicKey: 'public-key',
      },
    });
    certificateAccessPolicyFindUnique.mockResolvedValue({
      status: CertificateAccessPolicyStatus.BANNED,
      banReason: 'User is under permanent certificate restriction.',
      bannedAt: new Date('2026-04-28T09:30:00.000Z'),
      unbanReason: null,
      unbannedAt: null,
      updatedAt: new Date('2026-04-28T09:30:00.000Z'),
    });

    await expect(
      service.approveRequest('request-1', 'admin-1'),
    ).rejects.toThrow(
      new ConflictException(
        'This certificate request cannot be approved because certificate access for this user is currently banned. Reason: User is under permanent certificate restriction.',
      ),
    );
  });

  it('returns certificate status context with policy and latest revocation', async () => {
    const {
      service,
      personalCertificateFindFirst,
      certificateRequestFindFirst,
      certificateAccessPolicyFindUnique,
    } = createService();

    personalCertificateFindFirst
      .mockResolvedValueOnce({
        id: 'cert-2',
        serialNumber: 'SERIAL-2',
        subjectCN: 'Ishimwe Patrick',
        notBefore: new Date('2026-04-01T00:00:00.000Z'),
        notAfter: new Date('2027-04-01T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'cert-1',
        serialNumber: 'SERIAL-1',
        revokedAt: new Date('2026-04-20T09:00:00.000Z'),
        revokedReason: 'Certificate revoked by platform administrators.',
      });
    certificateRequestFindFirst.mockResolvedValue({
      ...PENDING_REQUEST,
      status: CertificateRequestStatus.REJECTED,
      reviewReason: 'Resubmit after identity review.',
    });
    certificateAccessPolicyFindUnique.mockResolvedValue({
      status: CertificateAccessPolicyStatus.BANNED,
      banReason: 'Manual trust review in progress.',
      bannedAt: new Date('2026-04-28T09:30:00.000Z'),
      unbanReason: null,
      unbannedAt: null,
      updatedAt: new Date('2026-04-28T09:30:00.000Z'),
    });

    const result = await service.getCurrentStatus('user-1');

    expect(result.accessPolicy.isBanned).toBe(true);
    expect(result.accessPolicy.banReason).toBe(
      'Manual trust review in progress.',
    );
    expect(result.latestRequest?.status).toBe(
      CertificateRequestStatus.REJECTED,
    );
    expect(result.latestRevocation?.serialNumber).toBe('SERIAL-1');
    expect(result.currentCertificate?.serialNumber).toBe('SERIAL-2');
  });
});
