import { ConfigModule, registerAs } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const fakeStorageConfig = registerAs('storage', () => ({
  endpoint: 'http://storage:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKey: 'access',
  secretKey: 'secret',
  bucket: 'bucket',
  forcePathStyle: true,
}));

describe('StorageModule', () => {
  it('should compile and expose StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [fakeStorageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
  });
});
