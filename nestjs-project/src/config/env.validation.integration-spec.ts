import { envValidationSchema } from './env.validation';
import storageConfig from './storage.config';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://storage:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
  S3_BUCKET: 'bucket',
  VIDEO_QUEUE_NAME: 'queue',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema - storage and queue', () => {
  it('should abort when S3_BUCKET is missing, naming the key', () => {
    const rest: Record<string, string> = { ...requiredEnv };
    delete rest.S3_BUCKET;
    const { error } = envValidationSchema.validate(rest, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_BUCKET');
  });

  it('should apply upload and queue defaults', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(value.UPLOAD_MAX_BYTES).toBe(10737418240);
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should reject a part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1024' });
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });
});

describe('storageConfig defaults', () => {
  it('should assume upload limits when the env keys are absent', () => {
    const saved = {
      max: process.env.UPLOAD_MAX_BYTES,
      part: process.env.UPLOAD_PART_SIZE_BYTES,
    };
    delete process.env.UPLOAD_MAX_BYTES;
    delete process.env.UPLOAD_PART_SIZE_BYTES;
    try {
      const config = storageConfig();
      expect(config.uploadMaxBytes).toBe(10737418240);
      expect(config.uploadPartSizeBytes).toBe(67108864);
    } finally {
      if (saved.max !== undefined) process.env.UPLOAD_MAX_BYTES = saved.max;
      if (saved.part !== undefined)
        process.env.UPLOAD_PART_SIZE_BYTES = saved.part;
    }
  });
});

describe('jest setup', () => {
  it('should isolate the video queue name from the .env value', () => {
    expect(process.env.VIDEO_QUEUE_NAME).toMatch(/-test$/);
  });

  it('should sign test URLs with the internal storage endpoint', () => {
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe(process.env.S3_ENDPOINT);
  });
});
