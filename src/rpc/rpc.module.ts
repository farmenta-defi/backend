import { Global, Module } from '@nestjs/common';
import { RpcService } from './rpc.service.js';

@Global()
@Module({ providers: [RpcService], exports: [RpcService] })
export class RpcModule {}
