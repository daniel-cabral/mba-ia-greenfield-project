import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { MailService } from '../../src/mail/mail.service';
import { StorageModule } from '../../src/storage/storage.module';
import { MediaExtractionService } from '../../src/videos/media-extraction.service';
import { VideoProcessor } from '../../src/videos/video.processor';
import { VideosModule } from '../../src/videos/videos.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { User } from '../../src/users/entities/user.entity';

export interface E2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

const PASSWORD = 'password123';

/**
 * Boots AppModule with the same global config as main.ts. With
 * `withProcessor`, the queue consumer also runs inside the test process
 * (the test queue is never read by the dev worker).
 */
export async function createE2eApp(
  options: { withProcessor?: boolean } = {},
): Promise<E2eContext> {
  const moduleFixture = await Test.createTestingModule({
    imports: options.withProcessor
      ? [AppModule, VideosModule, StorageModule]
      : [AppModule],
    providers: options.withProcessor
      ? [MediaExtractionService, VideoProcessor]
      : [],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

/** Registers, confirms and logs in a user through the public auth routes. */
export async function registerConfirmedUser(
  context: E2eContext,
  email: string,
): Promise<TestUser> {
  const { app, dataSource } = context;
  const mailService = app.get(MailService);
  let confirmationToken = '';
  const spy = jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: PASSWORD })
    .expect(201);
  spy.mockRestore();

  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  const user = await dataSource.getRepository(User).findOneByOrFail({ email });
  return {
    id: user.id,
    email,
    accessToken: (login.body as { access_token: string }).access_token,
  };
}
