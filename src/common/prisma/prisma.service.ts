import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createPrismaClientOptions, PrismaClient } from '@mucyora/db';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super(createPrismaClientOptions());
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
